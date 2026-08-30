/**
 * Escrow-backed billing execution for one subscription period (Issue #47).
 *
 * A charge funds an escrow from buyer -> seller for the period's amount and
 * immediately releases it — a subscription charge is a completed payment,
 * not something held pending delivery, so there's no reason to leave it
 * escrowed. This deliberately bypasses `escrowCoordinator`/`payment_records`:
 * that table's `order_id` is a hard FK into the marketplace `orders` table,
 * and a recurring billing period has no corresponding order. Idempotency
 * and audit for subscription charges live in `subscription_charges`
 * (`chargeStore.ts`) instead.
 */

import { createLogger } from "@delegolabs/utils";
import { getEscrowContractId } from "../../escrow/config.js";
import {
  extractEscrowIdFromTx,
  orderIdToContractBytes,
  submitContractInvocation,
} from "../escrowCoordinator/contractClient.js";
import { getChargeStore, type SubscriptionCharge } from "./chargeStore.js";
import { UnsupportedPaymentMethodError } from "./types.js";
import type { Subscription, SubscriptionPlan } from "./types.js";

const log = createLogger("payments:subscriptions:billing", process.env.LOG_LEVEL ?? "info");

const DEFAULT_TIMEOUT_LEDGERS = Number(process.env.SUBSCRIPTION_ESCROW_TIMEOUT_LEDGERS ?? 17_280);

function parseEscrowId(escrowId: string): number {
  const id = Number(escrowId);
  if (!Number.isInteger(id) || id < 0) {
    throw new Error(`Invalid escrow ID returned for subscription charge: ${escrowId}`);
  }
  return id;
}

/**
 * Charges one billing period against the subscription's escrow contract.
 * Idempotent per (subscriptionId, periodStart): a period already marked
 * "succeeded" is returned as-is without touching the chain again.
 */
export async function chargeSubscriptionPeriod(
  subscription: Subscription,
  plan: SubscriptionPlan,
  periodStart: string,
  periodEnd: string,
  amount: string
): Promise<SubscriptionCharge> {
  const store = getChargeStore();
  let charge = await store.getOrCreate({ subscriptionId: subscription.id, periodStart, periodEnd, amount });

  if (charge.status === "succeeded") {
    return charge;
  }

  if (subscription.paymentMethod.type !== "escrow") {
    throw new UnsupportedPaymentMethodError(subscription.paymentMethod.type);
  }

  charge = await store.incrementAttempt(charge.id);
  const contractId = subscription.paymentMethod.escrowContractId ?? getEscrowContractId();
  const reference = `${subscription.id}:${periodStart}`;

  try {
    const fundTx = await submitContractInvocation({
      sourceAddress: subscription.buyerAddress,
      contractId,
      method: "deposit",
      args: [
        subscription.buyerAddress,
        subscription.sellerAddress,
        plan.currency,
        amount,
        orderIdToContractBytes(reference),
        DEFAULT_TIMEOUT_LEDGERS,
      ],
      memo: `Subscription ${subscription.id} charge for period starting ${periodStart}`,
      amountStroops: amount,
    });

    if (!fundTx.success) {
      return store.update(charge.id, { status: "failed", failureReason: "Fund transaction failed on-chain" });
    }

    // The contract returns the new escrow's u64 id as the transaction's
    // return value; the wallet-queue submission path doesn't decode it for
    // us, so callers extract it the same way escrowCoordinator does for a
    // regular escrow deposit (see escrowCoordinator/index.ts fundEscrow).
    const escrowId = await extractEscrowIdFromTx(fundTx.hash);
    charge = await store.update(charge.id, { fundTxHash: fundTx.hash, escrowId });

    const releaseTx = await submitContractInvocation({
      sourceAddress: subscription.sellerAddress,
      contractId,
      method: "release",
      args: [parseEscrowId(escrowId), subscription.sellerAddress],
      memo: `Release subscription ${subscription.id} charge for period starting ${periodStart}`,
    });

    if (!releaseTx.success) {
      return store.update(charge.id, {
        status: "failed",
        failureReason: "Release transaction failed on-chain after funding succeeded",
      });
    }

    log.info("Subscription period charged", {
      subscriptionId: subscription.id,
      periodStart,
      amount,
      fundTxHash: fundTx.hash,
      releaseTxHash: releaseTx.hash,
    });

    return store.update(charge.id, { status: "succeeded", releaseTxHash: releaseTx.hash, failureReason: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown subscription billing error";
    log.error("Subscription period charge failed", { subscriptionId: subscription.id, periodStart, error: message });
    return store.update(charge.id, { status: "failed", failureReason: message });
  }
}

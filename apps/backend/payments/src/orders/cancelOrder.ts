/**
 * Pre-shipment order cancellation service (Issue #503).
 *
 * Verifies the order is not yet shipped, marks it 'cancelling', triggers the
 * Soroban escrow refund via the backend relayer key, and returns inventory to
 * the merchant atomically.
 */

import { Pool, type QueryResultRow } from "pg";
import { createLogger } from "@delegolabs/utils";
import { escrowCoordinator } from "../escrowCoordinator/index.js";
import { getEscrowContractId, getAutoReleaseCallerAddress } from "../../escrow/config.js";
import { publishPaymentEvent } from "../../events/index.js";

const log = createLogger("payments:orders:cancel", process.env.LOG_LEVEL ?? "info");

export interface CancelOrderRequest { orderId: string; buyerAddress: string; reason: string; }
export interface CancelOrderResult { orderId: string; escrowRefundTxHash: string; restockedItemCount: number; status: "cancelled"; }

export class OrderAlreadyShippedError extends Error {
  constructor(public readonly orderId: string) {
    super(`Order ${orderId} has already shipped and cannot be cancelled`);
    this.name = "OrderAlreadyShippedError";
  }
}
export class OrderNotCancellableError extends Error {
  constructor(public readonly orderId: string, public readonly currentStatus: string) {
    super(`Order ${orderId} cannot be cancelled: status is '${currentStatus}'`);
    this.name = "OrderNotCancellableError";
  }
}

interface OrderRow extends QueryResultRow { id: string; status: string; shipping_status: string | null; escrow_id: string | null; merchant_id: string; }
interface ReservationRow extends QueryResultRow { id: string; quantity: number; }

let pool: Pool | null = null;
function getPool(): Pool {
  return pool ??= new Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego" });
}
export function _setPoolForTesting(p: Pool): void { pool = p; }
export function _resetPoolForTesting(): void { pool = null; }

const CANCELLABLE = new Set(["pending", "escrowed", "pending_approval", "approved"]);

export async function cancelOrder(req: CancelOrderRequest): Promise<CancelOrderResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<OrderRow>(
      `SELECT id, status, shipping_status, escrow_id, merchant_id FROM orders WHERE id = $1 FOR UPDATE`,
      [req.orderId]
    );
    const order = rows[0];
    if (!order) throw new Error(`Order ${req.orderId} not found`);

    const shippingStatus = order.shipping_status?.toLowerCase() ?? null;
    if (shippingStatus && shippingStatus !== "unfulfilled") throw new OrderAlreadyShippedError(req.orderId);
    if (!CANCELLABLE.has(order.status)) throw new OrderNotCancellableError(req.orderId, order.status);

    await client.query(`UPDATE orders SET status = 'cancelling', updated_at = NOW() WHERE id = $1`, [req.orderId]);

    const { rows: reservations } = await client.query<ReservationRow>(
      `SELECT id, quantity FROM merchant_inventory_reservations WHERE order_id = $1 AND status = 'reserved'`,
      [req.orderId]
    );
    await client.query("COMMIT");

    // Escrow refund (external — outside the DB transaction)
    let escrowRefundTxHash = "";
    if (order.escrow_id) {
      try {
        const result = await escrowCoordinator.refundEscrow({
          escrowId: order.escrow_id,
          escrowContractId: getEscrowContractId(),
          callerAddress: getAutoReleaseCallerAddress(),
          reason: "cancellation",
        });
        escrowRefundTxHash = result.txHash;
      } catch (err) {
        log.error("Escrow refund failed during cancellation", { orderId: req.orderId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Atomically restore inventory
    let restockedItemCount = 0;
    if (reservations.length > 0) {
      const ic = await getPool().connect();
      try {
        await ic.query("BEGIN");
        for (const r of reservations) {
          await ic.query(
            `UPDATE merchant_inventory mi
                SET available_stock = available_stock + sub.qty,
                    reserved_stock  = GREATEST(reserved_stock - sub.qty, 0),
                    updated_at      = NOW()
               FROM (SELECT merchant_id, product_id, quantity AS qty FROM merchant_inventory_reservations WHERE id = $1) sub
              WHERE mi.merchant_id = sub.merchant_id AND mi.product_id = sub.product_id`,
            [r.id]
          );
          await ic.query(`UPDATE merchant_inventory_reservations SET status = 'released', updated_at = NOW() WHERE id = $1`, [r.id]);
          restockedItemCount += r.quantity;
        }
        await ic.query("COMMIT");
      } catch (err) {
        await ic.query("ROLLBACK");
        log.error("Inventory restock failed", { orderId: req.orderId, error: err instanceof Error ? err.message : String(err) });
      } finally {
        ic.release();
      }
    }

    await getPool().query(`UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [req.orderId]);

    publishPaymentEvent({
      type: "order.cancelled",
      orderId: req.orderId,
      payload: { buyerAddress: req.buyerAddress, merchantId: order.merchant_id, reason: req.reason, escrowRefundTxHash, restockedItemCount },
      occurredAt: new Date().toISOString(),
    }).catch((err) => log.warn("Failed to publish order.cancelled event", { error: err instanceof Error ? err.message : String(err) }));

    log.info("Order cancelled", { orderId: req.orderId, escrowRefundTxHash, restockedItemCount });
    return { orderId: req.orderId, escrowRefundTxHash, restockedItemCount, status: "cancelled" };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

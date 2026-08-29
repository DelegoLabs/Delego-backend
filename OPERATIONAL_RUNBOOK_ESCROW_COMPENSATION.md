# Operational Runbook: Escrow Compensation (Issue #35)

## Quick Reference

### Health Check

```sql
-- Any compensation runs currently stuck on escrow funds specifically?
SELECT workflow_id, status, failed_steps, cause, attempts, updated_at
FROM workflow_compensation_outcomes
WHERE status = 'escrow_stuck'
ORDER BY updated_at DESC;

-- Should show: none, or only very recent rows still within their retry window
```

```sql
-- Cross-reference with payment_records to see the escrow's actual on-chain-tracked status
SELECT pr.order_id, pr.escrow_id, pr.status, pr.failure_reason, pr.updated_at
FROM payment_records pr
JOIN workflow_compensation_outcomes wco ON wco.workflow_id = pr.order_id
WHERE wco.status = 'escrow_stuck';
```

### Common Commands

```bash
# View recent compensation outcomes
psql $DATABASE_URL -c "
  SELECT workflow_id, status, attempts, cause, updated_at
  FROM workflow_compensation_outcomes
  ORDER BY updated_at DESC
  LIMIT 20;"

# Tail orchestrator compensation logs
tail -f /var/log/delego/orchestrator.log | grep -i "compensation"

# Manually retry release for a specific order (idempotent — safe even if it already succeeded)
curl -X POST http://localhost:3014/api/v1/orders/<orderId>/release

# Manually retry refund for a specific order (idempotent)
curl -X POST http://localhost:3014/api/v1/orders/<orderId>/refund \
  -H "Content-Type: application/json" \
  -d '{"refundReasonCode": "system_error"}'
```

## Background

When a purchase saga fails after reaching `ESCROW_FUNDED`, `runCompensation()`
(`apps/backend/orchestrator/workflows/purchase/compensation.ts`) undoes the
completed steps in reverse order:

1. `settleEscrow` (if it ran) — calls the payments service's
   `refundOrder()`/`POST /api/v1/orders/:orderId/refund`.
2. `confirmPurchase` — calls the merchant cancellation client (soft-skipped if
   no merchant service is configured; see "Scenario 3" below).
3. `fundEscrow` — calls the payments service's `settleOrder()` (release) /
   `POST /api/v1/orders/:orderId/release`.

Both payments calls are **idempotent per orderId** (keyed on
`payment_records.status`), so retrying a compensation step — whether via the
saga's own bounded retry loop or a manual curl from this runbook — never
double-refunds or double-releases the same escrow.

## Operations Scenarios

### Scenario 1: Investigating an `escrow_stuck` Compensation Outcome

**Problem**: `workflow_compensation_outcomes.status = 'escrow_stuck'` for an
order, and/or a dead-letter-queue entry with reason `"Escrow compensation
stuck: ..."` (pushed via the same `moveToDeadLetter()` DLQ used for stuck
workflows generally — see `workflows/timeout.ts`).

**Step 1: Identify the failure**

```sql
SELECT workflow_id, failed_steps, cause, attempts, updated_at
FROM workflow_compensation_outcomes
WHERE workflow_id = '<orderId>';
```

`failed_steps` is a JSON array of `{ step, error }`. The `step` will be
`fundEscrow` (release failed) or `settleEscrow` (refund failed) — the two
escrow-critical steps. A `confirmPurchase` (merchant cancel) failure alone
does **not** produce `escrow_stuck`, since escrow funds aren't at risk from a
failed merchant-side cleanup call.

**Step 2: Check by error type**

- **"Payments service unavailable" / "ECONNREFUSED" / "ETIMEDOUT"** → payments
  service is down or unreachable from the orchestrator.
  ```bash
  curl -sf http://localhost:3014/health || echo "payments service is down"
  ```
  Restart/redeploy payments, then retry (Step 3 below).

- **"SETTLEMENT_SOURCE_ADDRESS environment variable is not configured"** →
  payments service misconfiguration, not transient. Fix the env var and
  restart payments before retrying — retrying without fixing this will fail
  identically every time.

- **"Release/Refund transaction failed on-chain"** → the Soroban transaction
  itself was rejected. Check the escrow contract state directly:
  ```sql
  SELECT id, order_id, escrow_id, escrow_contract_id, status, failure_reason
  FROM payment_records
  WHERE order_id = '<orderId>';
  ```
  Cross-check on-chain via the payments reconciliation worker
  (`apps/backend/payments/src/reconciliation/worker.ts`) or a direct
  `readEscrowFromChain()` call — a mismatch between `payment_records.status`
  and the actual on-chain state usually means the transaction landed but the
  DB write raced/failed, or vice versa.

- **"Cannot release order ... escrow was already refunded" / "Cannot refund
  order ... escrow was already released"** → not a transient failure; this
  means the escrow already reached the *other* terminal state (e.g. a
  concurrent operator action, or a race with the on-chain event listener).
  Compare `payment_records.status` (Step above) against what the saga expected
  and decide manually which side is correct — do not blindly retry, since a
  retry will keep failing identically by design (this is the double-spend
  guard, not a bug).

**Step 3: Retry**

Once the underlying issue (Step 2) is fixed, the idempotent per-orderId
endpoints make retrying safe:

```bash
# For a stuck release (fundEscrow failed)
curl -X POST http://localhost:3014/api/v1/orders/<orderId>/release

# For a stuck refund (settleEscrow failed)
curl -X POST http://localhost:3014/api/v1/orders/<orderId>/refund \
  -H "Content-Type: application/json" \
  -d '{"refundReasonCode": "system_error"}'
```

Both return `{ "data": { "status": "released" | "refunded", "alreadySettled": true | false, ... } }`.
`alreadySettled: true` means a previous attempt already succeeded on-chain —
this is the expected (and safe) outcome if you retry after the transaction
actually landed despite the orchestrator reporting failure (e.g. it landed but
the response was lost to a network blip).

**Step 4: Verify and clear**

```sql
-- Confirm payment_records reflects the terminal state
SELECT status, release_tx_hash, refund_tx_hash FROM payment_records WHERE order_id = '<orderId>';

-- Re-run compensation to refresh workflow_compensation_outcomes (safe — idempotent)
```

Once resolved, the next successful compensation run overwrites the
`escrow_stuck` row with `status = 'success'` (upsert by `workflow_id`) — there
is no separate "clear" step.

### Scenario 2: A Bounded Retry Exhausted Before Succeeding (Not Yet `escrow_stuck`)

**Problem**: Logs show `"Compensation step failed"` for `fundEscrow` or
`settleEscrow`, but `retryWithLeaseBudget` (compensation.ts) gave up after
~20 seconds rather than immediately.

**Explanation**: Retries are bounded by wall-clock time (default 20s budget,
comfortably under the saga coordinator's 30s claim lease — see
`src/saga/coordinator.ts`'s `DEFAULT_CLAIM_LEASE_MS`), not by attempt count.
This is intentional: a compensation step must finish (success or failure)
before its saga lease could expire and let another runner reclaim the same
step, which would otherwise risk a double-execution race. If the payments
service takes longer than the budget to recover, the step fails and the run
is recorded — go to Scenario 1.

**If retries are exhausting too quickly for your environment** (e.g. payments
service typically takes >20s to recover from a restart), the budget is a
constructor parameter (`createDefaultPurchaseCompensationSteps(deps,
retryBudgetMs)`) — increase it, but keep it below the saga's `claimLeaseMs` to
preserve the invariant above.

### Scenario 3: Merchant Cancellation Always Skipped

**Problem**: Every compensation run's `confirmPurchase` step logs
`"Compensation: merchant cancellation client not configured, skipping"`.

**Expected today**: No merchant microservice exists in this monorepo yet
(`apps/backend` has gateway, notifications, orchestrator, payments, wallet —
no merchant service). `DEFAULT_PURCHASE_COMPENSATION_STEPS` uses
`defaultMerchantCancellationClient`, a stub that always throws
`"MerchantCancellationClient not configured"`; `confirmPurchase` catches
exactly that error and treats it as a soft-skip so escrow fund recovery isn't
blocked on merchant-side cleanup.

**Once a merchant service exists**: wire a real client —

```ts
import { createDefaultPurchaseCompensationSteps } from "./compensation.js";
import { createHttpPaymentsCompensationClient } from "./paymentsCompensationClient.js";
import { createHttpMerchantCancellationClient } from "./merchantCancellationClient.js";

const steps = createDefaultPurchaseCompensationSteps({
  paymentsClient: createHttpPaymentsCompensationClient(),
  merchantClient: createHttpMerchantCancellationClient(),
});
```

and pass `steps` as `runCompensation`'s `allSteps` argument. After this
change, a real merchant-side failure will surface as a `partial_failure`
(not `escrow_stuck`, since merchant cleanup failing doesn't put funds at
risk) requiring separate manual merchant-order follow-up.

### Scenario 4: Confirming a Refund/Release Actually Reached the Buyer/Seller

**Problem**: Compensation reports success, but need to confirm the on-chain
event and downstream buyer notification actually fired.

```sql
-- Confirm the transaction hash and status
SELECT release_tx_hash, refund_tx_hash, status, updated_at
FROM payment_records
WHERE order_id = '<orderId>';
```

The escrow contract emits an on-chain `escrow.released` / `escrow.refunded`
event on a successful release/refund transaction. Notifications' escrow event
listener (`apps/backend/notifications/src/escrowEventListener.ts`) polls the
Soroban RPC for these events and dispatches the buyer-facing
email/push notification automatically — no separate "send refund
confirmation" call is needed from the orchestrator; the on-chain event is the
trigger, mirroring how `escrow_created`/`escrow_disputed` notifications work
today.

```bash
# Confirm the listener processed the event (dedup key = txHash:eventIndex)
tail -100 /var/log/delego/notifications.log | grep "<txHash>"
```

If the transaction hash exists in `payment_records` but no notification log
line appears after a few polling intervals
(`ESCROW_EVENT_POLL_INTERVAL_MS`, default 6s), check the listener's Redis
cursor and RPC connectivity — this is a pre-existing, separate concern from
compensation itself (see #56).

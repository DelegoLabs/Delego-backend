# Escrow Auto-Release on Delivery Confirmation (Issue #45)

Automates escrow release once delivery is confirmed, removing the need for
manual intervention on successful transactions.

## Webhook

```
POST /escrow/:escrowId/delivery-confirmed
X-Signature: <hex HMAC-SHA256 of the raw request body>
Content-Type: application/json

{
  "orderId": "order-123",
  "deliveryProof": {
    "trackingNumber": "1Z999AA10123456784",
    "carrier": "UPS",
    "deliveredAt": "2026-08-27T10:00:00.000Z",
    "recipientSignature": "J. Doe",
    "photos": ["https://.../proof1.jpg"],
    "gpsCoordinates": { "lat": 37.7749, "lng": -122.4194 }
  },
  "confirmedBy": "merchant-42",
  "timestamp": "2026-08-27T10:00:05.000Z"
}
```

The signature is `HMAC-SHA256(rawBody, ESCROW_WEBHOOK_SECRET)`, hex-encoded,
either bare or prefixed as `sha256=<hex>`. Requests with a missing or
incorrect signature are rejected with `401 Unauthorized` before the body is
even parsed. If `ESCROW_WEBHOOK_SECRET` isn't configured, the endpoint fails
closed with `503`.

### Responses

| Condition                                   | Status | Body                                                |
| -------------------------------------------- | ------ | ---------------------------------------------------- |
| Immediate release attempted                  | 200    | `ReleaseResult` (`success` reflects the outcome)      |
| Release scheduled (`delayMinutes > 0`)       | 202    | `{ escrowId, orderId, scheduled: true, jobId, scheduledFor }` |
| Escrow is disputed                           | 409    | `{ error: { code: "ESCROW_DISPUTED" } }`              |
| Escrow is not `funded`                       | 400    | `{ error: { code: "ESCROW_NOT_RELEASABLE" } }`        |
| Invalid signature                            | 401    | `{ error: { code: "UNAUTHORIZED" } }`                 |
| Malformed payload                            | 400    | `{ error: { code: "VALIDATION_ERROR" } }`             |

## Configuration (`AutoReleaseConfig`, per escrow)

| Field                    | Default | Notes                                                          |
| ------------------------ | ------- | --------------------------------------------------------------- |
| `enabled`                 | `true`  | When `false`, confirmations are accepted but no release occurs. |
| `delayMinutes`            | `0`     | `0` releases immediately; `>0` schedules via the release queue. |
| `partialReleaseEnabled`   | `false` | Enables pro-rata release across multiple confirmations.         |
| `requiredConfirmations`   | `1`     | Confirmations needed before the *full* amount is released.      |

Set via `setAutoReleaseConfig()` (`src/autoRelease/configStore.ts`).

## Partial (pro-rata) releases

The on-chain `release` contract call transfers the escrow's **entire**
balance — it has no notion of a partial amount. When
`partialReleaseEnabled` is set with `requiredConfirmations > 1`, interim
confirmations are accounted for pro-rata *off-chain* (a `ReleaseResult` with
`success: true` but no `transactionHash`); only the final confirmation
submits the actual on-chain release, at which point `remainingAmount`
reaches `"0"`.

## Resilience

- **Retries**: on-chain release calls are retried up to 3 times with
  exponential backoff (2s, 4s, 8s) — see `src/autoRelease/retry.ts`.
- **Dispute guard**: a `disputed` escrow blocks auto-release entirely.
  Resolution requires `adminOverrideRelease()` (`src/autoRelease/service.ts`),
  which bypasses the automated check for authorized admin/arbiter tooling.
- **Delay queue**: delayed releases run on a BullMQ queue
  (`escrow-auto-release`) in production, falling back to an in-memory,
  test-controllable scheduler under `NODE_ENV=test` / `MOCK_REDIS=true` /
  `CI=true` — see `src/autoRelease/releaseQueue.ts`.

## Events

`release_initiated`, `release_completed`, and `release_failed` are published
on the shared `payments:events` stream (see `src/autoRelease/events.ts`),
consistent with the rest of the payment lifecycle events.

## Environment variables

| Variable                              | Purpose                                                      |
| -------------------------------------- | ------------------------------------------------------------- |
| `ESCROW_WEBHOOK_SECRET`                | Shared secret used to verify the `X-Signature` HMAC.          |
| `ESCROW_AUTO_RELEASE_CALLER_ADDRESS`   | Stellar address authorized to submit auto-release `release` calls (falls back to `SETTLEMENT_SOURCE_ADDRESS`). |

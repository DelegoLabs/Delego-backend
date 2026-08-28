# Redis Pub/Sub Publisher

Bounded-retry wrapper around Redis `PUBLISH` with structured logging.

## Usage

```ts
import { Redis, type Redis as RedisType } from "ioredis";
import { createLogger } from "@delegolabs/utils";
import { RedisPublisher } from "./pubsub/index.js";

const client = new Redis(REDIS_URL);
const log = createLogger("orchestrator");

const publisher = new RedisPublisher(client, log, 3, 100);

const result = await publisher.publish("orders:created", JSON.stringify(event));
// result: { channel: "orders:created", delivered: true, attempts: 1 }
```

## `PublishResult`

| Field     | Type     | Description                              |
|-----------|----------|------------------------------------------|
| channel   | string   | Redis channel name                       |
| delivered | boolean  | true when publish succeeded              |
| attempts  | number   | number of attempts made                  |
| error?    | string   | error message on failure                 |

## Retry Behaviour

- Transient errors (`ECONNRESET`, `ETIMEDOUT`, `READONLY`, `LOADING`, etc.) are retried with exponential backoff: `baseDelayMs * 2^(attempt-1)`
- Non-transient errors return immediately without retry
- After all retries are exhausted the final result has `delivered: false`

## OutboxRelay (Issue #33)

`RedisPublisher.publish()` above is a *best-effort* transport primitive — even with its
retries, a process crash between a domain DB write and the `publish()` call still loses
the event permanently. `../events/outboxRelay.ts` builds durable delivery on top of it:

1. A producer (e.g. `workflows/purchase/index.ts`'s `transitionWorkflow`) inserts a row
   into `service_event_outbox` in the **same DB transaction** as its domain write, instead
   of calling `RedisPublisher` directly. If the process crashes right after commit, the
   event is safely durable in Postgres — nothing is lost.
2. `OutboxRelay` (started from `src/index.ts`) polls `service_event_outbox` for `pending`
   rows due for (re)delivery, publishes each via `RedisPublisher`, and marks it
   `published`. On failure it retries with exponential backoff + full jitter, up to
   `maxAttempts`, after which the row is marked terminally `failed` for manual replay.
3. Multiple orchestrator instances can run the relay concurrently: claiming a batch uses
   `SELECT ... FOR UPDATE SKIP LOCKED` (`PostgresServiceEventOutboxStore.claimPendingBatch`
   in `../events/postgres-service-event-outbox.ts`), so two instances polling at the same
   time can never claim (and therefore double-publish) the same row.

### Interplay with consumer-side dedupe (`processed_messages`, migration 006)

The outbox guarantees **at-least-once** delivery, not exactly-once:

- A relay crash between a successful `publish()` and the `markPublished()` write causes
  the same row to be re-claimed and re-published on the next poll.
- A retried row that actually *did* reach Redis on an earlier attempt (e.g. the publish
  succeeded but the response was lost) will be republished again on retry.

Consumers MUST NOT assume "delivered once" — they must dedupe using
`checkAndMarkProcessed()` (`../messaging/processed-messages.ts`) keyed on a stable message
id from the event payload, exactly as contract-event consumers already do against
`processed_contract_events`. The outbox and `processed_messages` are complementary halves
of the same at-least-once-with-idempotent-consumption pattern: the outbox guarantees the
event is never *lost* before it reaches Redis; `processed_messages` guarantees it's never
*double-applied* after a consumer receives it (possibly more than once).

# @delegolabs/orchestrator

Delego **orchestrator** service.

## Development

```bash
pnpm --filter @delegolabs/orchestrator dev
```

Health check: `GET http://localhost:3010/health`

## Saga coordinator

`src/saga/` implements a generic saga coordinator pattern for reverting previously
executed steps across services when a downstream step fails:

- `SagaCoordinator` runs an ordered list of `SagaStep`s (`action` + `compensation`)
  against a `SagaStore`. On failure it transitions the saga to `compensating` and runs
  the compensation for each completed step in reverse order.
- `PostgresSagaStore` persists every step transition to the `saga_executions` table
  (added in `database/schema/002_orchestrator_sagas.sql`) so progress survives an
  orchestrator crash. `SagaCoordinator.recoverAll()` is called on startup to resume any
  saga left `running` or `compensating`.
- `SagaCoordinator.run()` is idempotent for an already-started `sagaId` — it resumes
  from persisted state instead of restarting, and `resume()` skips steps already marked
  complete. Compensation steps must themselves be idempotent, since a crash can interrupt
  compensation after a downstream side effect has already been applied but before the
  saga record is updated.
- `workflows/checkout/index.ts` wires this into checkout: `deposit-escrow` calls the
  payments service's `POST /escrow/deposit` and compensates via `POST
  /escrow/:escrowId/refund` if a later step fails. `confirm-checkout` is currently a
  context-only transition — it should call a gateway order-status endpoint once one
  exists.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://delego:delego@localhost:5432/delego` | Postgres connection for `saga_executions` |
| `DATABASE_POOL_MIN` / `DATABASE_POOL_MAX` | `2` / `10` | Sequelize pool sizing |
| `PAYMENTS_URL` | `http://localhost:3014` | Payments service base URL used by the checkout saga's escrow steps |

### HTTP endpoints

- `POST /checkout` — `{ orderId, sourceAddress, buyerAddress, sellerAddress }`, runs the
  checkout saga to completion (or compensation) and returns its final status.
- `GET /sagas/:sagaId` — current saga status and completed steps.
- `POST /sagas/:sagaId/resume` — manually resume a saga stuck in `running` or
  `compensating` (e.g. after a downstream outage is fixed).

## Reliable event publishing (Issue #216)

`src/events/service-event-outbox.ts` provides `insertServiceEventOutbox()` for writing
rows to `service_event_outbox` before publishing critical Redis events. Publishers should
insert in the same DB transaction as the domain mutation; a relay worker polls `pending`
rows and publishes to Redis, then marks them `published`.

## Idempotent workers (Issue #217)

`src/messaging/processed-messages.ts` provides `checkAndMarkProcessed(messageId, consumer)`
for Redis and contract-derived event consumers. Returns `true` on first delivery and
`false` on duplicate message ids. Backed by `processed_messages`
(`database/migrations/006_processed_messages.sql`).

## Human task management

`src/tasks/` implements human task management for workflows requiring manual approval,
review, data entry, verification or exception handling:

- **Lifecycle** — `created → assigned → claimed → in_progress → completed | rejected`,
  with `escalated` / `expired` driven by the SLA engine.
- **Routing** (`src/tasks/routing.ts`) — `round_robin`, `least_loaded`, `skill_based`,
  `priority` and `specific_user` strategies resolved per workflow+task type via
  `task_routing_rules`.
- **SLA** (`src/tasks/sla.ts`) — tasks are escalated past their `dueAt`, then expired
  after a configurable grace period. A background sweeper runs on a timer.
- **Service** (`src/tasks/service.ts`) — assign, claim, start, complete, reject,
  escalate, delegate, comments, attachments and bulk operations; completes validate
  `formData` against a JSON Schema subset.
- **Analytics** (`src/tasks/analytics.ts`) — cycle time, throughput and SLA breach rate
  per assignee / task type.
- **Real-time inbox** (`src/tasks/subscriptions.ts`) — publishes lifecycle events to
  Redis channels (`human-task:*`) for live UI updates.

Backed by `database/migrations/027_human_tasks.sql` (`human_tasks`,
`task_routing_rules`, `task_comments`, `task_attachments`, `task_delegations`).

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `TASK_SLA_SCAN_INTERVAL_MS` | `300000` | SLA sweeper interval (ms); `0` disables the background loop |
| `TASK_SLA_GRACE_HOURS` | `24` | Escalation grace period before a breached task expires |
| `ENABLE_TASK_EVENTS` | `true` | Set `false` to disable Redis real-time inbox events |
| `TASK_MAX_REQUEST_BODY_BYTES` | `1048576` | Max request body size for task endpoints |

### HTTP endpoints

- `POST /tasks` — create + route a task.
- `GET /tasks` — list/inbox query (`?assignee=&status=&type=&priority=&workflowType=&mine=true`).
- `GET /tasks/:id` — task detail with comments and attachments.
- `POST /tasks/:id/assign|claim|start|complete|reject|escalate|delegate` — lifecycle ops.
- `POST /tasks/:id/comments`, `POST /tasks/:id/attachments` (plus GET list).
- `POST /tasks/bulk` — apply one operation to many task ids.
- `GET/PUT /tasks/routing-rules` — manage routing rules.
- `POST /tasks/sla/scan` — on-demand SLA escalation/expiry sweep.
- `GET /tasks/analytics` — metrics for a period (`?start=&end=`).

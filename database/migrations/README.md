# Database Migrations

Deterministic, checksum-validated SQL migrations for Delego.

## Directory semantics

- `database/schema/` contains the **baseline schema** applied to a brand-new database.
- `database/migrations/` contains **incremental changes** applied after the baseline.
- Baseline files always run before incremental files.
- Within each directory, files run in ascending numeric-prefix order; the filename is the tie-breaker.

The current baseline is:

| Baseline | Description |
|----------|-------------|
| `001_initial.sql` | Users, wallets, orders, delegations, delegation policies, permission levels |
| `002_orchestrator_sagas.sql` | Orchestrator saga coordinator state |
| `003_purchase_workflows.sql` | Purchase workflow state persistence (Issue #54) |

The incremental migrations are:

| Migration | Description |
|-----------|-------------|
| `002_gateway_auth_limits.sql` | Gateway auth columns; spend limit, delegation policy, and permission level tables |
| `003_refresh_tokens.sql` | Refresh token storage |
| `004_processed_contract_events.sql` | Persist processed escrow contract events for deduplication |
| `005_service_event_outbox.sql` | Transactional outbox for reliable Redis / service event publishing (Issue #216) |
| `006_processed_messages.sql` | Idempotent consumer deduplication for Redis and contract-derived events (Issue #217) |
| `007_signing_key_versions.sql` | Signing key version metadata for encrypted wallet seeds (Issue #198) |
| `008_workflow_transition_audit.sql` | Lightweight audit records for workflow transitions (Issue #206) |
| `009_payment_records.sql` | Payment records for escrow coordinator fund/release/refund tracking |
| `010_escrow_funding_locks.sql` | Escrow funding lock table for double-funding prevention |
| `011_workflow_events.sql` | Event sourcing for workflow state transitions (Issue #354) |
| `012_notification_preferences.sql` | Persistent notification preferences per user (#135) |
| `013_soroban_transaction_ledger.sql` | Idempotent Soroban transaction ledger for submission, confirmation, and failure states |
| `014_payment_records_dispute.sql` | Dispute transactions on payment_records for the escrow coordinator |
| `015_oauth_providers.sql` | OAuth2 provider account linking |
| `016_in_app_notifications.sql` | Durable in-app notifications and indexes (Issues #58/#60) |
| `017_escrow_lock_metrics.sql` | Metrics tracking for escrow funding locks |
| `018_scheduled_notifications.sql` | Durable storage for scheduled/recurring notifications (Issue #59) |
| `019_service_event_outbox_relay.sql` | Retry/claim columns on `service_event_outbox` for the OutboxRelay worker (Issue #33) |
| `020_workflow_compensation_outcomes.sql` | Escrow compensation outcome per workflow record (Issue #35) |
| `021_workflow_timeout_analytics.sql` | Timeout analytics and escalation tracking (#145) |
| `022_redis_pubsub_dead_letters.sql` | Dead letter queue for Redis Pub/Sub failed deliveries (#123) |
| `023_transaction_dlq_and_monitoring.sql` | Transaction DLQ and monitoring tables (#143) |
| `024_soft_delete.sql` | Soft-delete columns, registry, cascade relations, and metrics view for users/wallets/delegations/orders (Issue #67) |
| `025_audit_log.sql` | Append-only, hash-chained audit log with DB-level immutability triggers, plus retention policy config (Issue #66) |
| `017_escrow_lock_metrics.sql` | Lock metrics tracking for escrow funding lock optimization (#147) |
| `017_scheduled_notifications.sql` | Durable storage for scheduled/recurring notifications, so the scheduler survives restarts (Issue #59) |
| `017_service_event_outbox_relay.sql` | Retry/claim columns on `service_event_outbox` for the OutboxRelay worker (Issue #33) |
| `018_workflow_compensation_outcomes.sql` | Escrow compensation outcome per workflow record (Issue #35) |
| `018_workflow_timeout_analytics.sql` | Workflow timeout analytics |
| `019_redis_pubsub_dead_letters.sql` | Dead letter queue for Redis Pub/Sub failed deliveries (#123) |
| `020_transaction_dlq_and_monitoring.sql` | Transaction dead letter queue and monitoring (#143) |
| `021_soft_delete.sql` | Soft-delete columns, registry, cascade relations, and metrics view for users/wallets/delegations/orders (Issue #67) |
| `022_audit_log.sql` | Append-only, hash-chained audit log with DB-level immutability triggers, plus retention policy config (Issue #66) |
| `023_notification_preference_center.sql` | Notification preference center: org defaults, JSONB preference documents, and migration history (Issue #115) |

## Naming rules

```text
<unique-number>_<short_description>.sql
```

- Numbers must be unique within their directory and must never be reused.
- Only forward `.sql` files are treated as migrations; matching `.down.sql` files provide rollback SQL and are ignored as standalone migrations.
- Filenames that do not match `<number>_<description>.sql` fail the migration run.

## Tracking

The runner creates a `schema_migrations` table:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  id BIGSERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  migration_group TEXT NOT NULL CHECK (migration_group IN ('schema', 'migration')),
  version INTEGER NOT NULL,
  checksum CHAR(64) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- Each file is tracked by its relative filename (`schema/001_initial.sql`) and its SHA-256 checksum.
- Each migration runs inside a transaction together with its tracking row, so a failed migration leaves no partial schema and no tracking record.
- Applied files with matching checksums are skipped, making reruns a no-op.
- Editing an already-applied file causes a **checksum mismatch** and the run fails before applying anything else. To change the schema, create a new migration instead.
- Deleting or renaming an applied migration file is also reported as an error.
- Duplicate version numbers within one directory fail validation before any SQL executes.
- Runs are serialized with the PostgreSQL advisory lock `hashtext('delegobackend:schema-migrations')`.

## Commands

```bash
# Apply all pending migrations
pnpm db:migrate

# Show applied/pending migrations and checksum health
pnpm db:migrate:status

# Print pending SQL without executing it
pnpm db:migrate:dry-run

# Generate the next forward/rollback pair
pnpm db:migrate:create add_example

# Roll back the latest migration (requires an explicit safety flag)
pnpm db:migrate -- --direction down --force

# Inspect rollback SQL through version 12
pnpm db:migrate -- --direction down --target 12 --dry-run
```

The runner connects using `DATABASE_URL` (defaults to `postgresql://delego:delego@localhost:5432/delego`). For tests, `DELEGO_SCHEMA_DIR` and `DELEGO_MIGRATIONS_DIR` can override the migration directories.

## Fresh setup

```bash
docker compose up -d --wait postgres
pnpm db:migrate
pnpm db:migrate:status
```

A clean database must contain all expected tables before backend services are started.

## Creating a migration

1. Run `pnpm db:migrate:status` to see the highest applied number.
2. Create `database/migrations/<next-number>_<description>.sql`. Never reuse or renumber existing files.
3. Write plain SQL — each file runs exactly once inside a transaction. Avoid non-transactional statements such as `CREATE INDEX CONCURRENTLY`.
4. Test locally against a clean database (`docker compose down -v && docker compose up -d --wait postgres && pnpm db:migrate`).
5. Update this README's migration table.
6. Never edit an applied migration file: the recorded SHA-256 checksum will no longer match and every subsequent `db:migrate`/`db:migrate:status` fails until the file is restored.

Rollback runs the matching `.down.sql` in a transaction and removes its history row only after the SQL succeeds. A rollback without a down file, or without `--force`, is refused. Review a rollback with `--dry-run` before executing it; production rollback should also be approved through the deployment change process.

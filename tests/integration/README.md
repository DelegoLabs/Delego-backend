# Integration Tests

Service-to-service integration tests, plus real-infrastructure coverage
(Issue #36) for the Postgres- and Redis-backed code paths that the
mocked unit suite (`pnpm test`, `MOCK_REDIS=true`) cannot exercise:

- `saga-recovery.integration.test.js` — saga persist → simulated crash →
  `recoverAll()` resumes to completion, against `PostgresSagaStore`.
- `outbox-relay-dedupe.integration.test.js` — outbox insert → relay
  (`SELECT ... FOR UPDATE SKIP LOCKED`) → consumer dedupe via
  `PostgresProcessedMessageStore`, including a concurrent-poller test that
  no row is double-claimed.
- `auth-roundtrip.integration.test.js` — register/login/refresh/logout
  round-trip through `authService.ts` against a real migrated database,
  including refresh-token rotation and reuse (theft) detection.
- `ownership-rules.integration.test.js` — delegation/wallet ownership
  checks against real rows and a real foreign-key constraint.
- `rate-limit.integration.test.js` — sliding/fixed-window rate limiting
  (`checkRateLimit`) against a real Redis connection (passed in via
  `RateLimitConfig.redisClient`, not the process-wide mock-forcing
  singleton in `src/rateLimit/redisClient.ts`).

## Running against real infrastructure

```sh
pnpm docker:up            # starts Postgres + Redis (see docker-compose.yml)
pnpm build                # compiles apps/backend/* to dist/ — the suites
                           # above import compiled output, matching this
                           # workspace's existing convention
pnpm db:migrate            # optional — the suites also apply migrations
                           # themselves to disposable per-suite databases
pnpm test:integration
```

Each real-infra suite probes its dependency (`isPostgresReachable()` /
`isRedisReachable()` in `src/helpers/infra.js`) and the relevant service's
compiled `dist/` output (`isServiceBuilt()`) before running, and calls
`describe.skip(...)` with a clear console message if either is missing —
mirroring the existing `database-migrations.test.js` pattern. This makes
`pnpm test:integration` safe to run with or without local infra: with
Postgres/Redis and a prior `pnpm build`, the suites run for real; without
either, they skip cleanly (exit 0) instead of failing.

## Running without real infrastructure

```sh
pnpm test:integration
```

Suites that need Postgres or Redis skip themselves (see above). The
placeholder/fixture suites (`health-check.test.js`,
`testcontainers-fixtures.test.js`) still run.

## CI

- `.github/workflows/ci.yml`'s `migrations` job starts Postgres only (no
  Redis service) and runs `pnpm test:integration` without a prior full
  `pnpm build` — so there, only the Postgres-backed suites that don't
  require compiled output would run; today none do without a build step,
  so they skip via the `isServiceBuilt()` guard and the job's original
  migration-runner assertions are unaffected.
- The `test-integration` job builds all services and starts both Postgres
  and Redis, so the full suite listed above runs for real. It runs after
  `build` and is additive — the mocked `test` job is unchanged and stays
  fast.

## Payments/escrow Soroban suite

`payments-escrow.testnet.test.js` (via `pnpm --filter
@delegolabs/tests-integration test:payments-escrow`) is a separate,
pre-existing suite that deploys and exercises a compiled Soroban escrow
contract on testnet. It requires a contract build under
`contracts/target/wasm32-unknown-unknown/release/` and is not part of the
default `pnpm test:integration` script.

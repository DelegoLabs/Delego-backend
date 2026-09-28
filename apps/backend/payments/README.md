# @delegolabs/payments

Delego **payments** service.

### Escrow Funding Lock & Double-Funding Prevention

Protects checkout workflows against race conditions and concurrent deposit attempts on the same order.

- **Atomic Redis Locks**: Uses atomic `SET key lockToken PX ttlMs NX` locks (`escrow:lock:funding:<orderId>`) to prevent duplicate in-flight funding operations.
- **Scripted Release**: Executes an atomic Lua script (`RELEASE_LOCK_LUA`) to ensure lock deletion is only performed by the acquiring lock token.
- **Defense in Depth**: Backed by database unique constraints on `payment_records(order_id)` and `escrow_funding_locks(order_id)` (`010_escrow_funding_locks.sql`).
- **Conflict Responses**: Rejects duplicate concurrent requests with an HTTP `409 Conflict` envelope (`DUPLICATE_FUNDING_REQUEST`) without queuing duplicate blockchain transactions.

See `validation.ts` (`acquireLock`, `releaseLock`) for technical specifications.

## Development

```bash
pnpm --filter @delegolabs/payments dev
```

Health check: `GET http://localhost:3014/health`

Escrow coordinator health probe: `GET http://localhost:3014/escrow/health`

Returns dependency readiness for escrow funding and settlement:

```json
{
  "data": {
    "database": "ok",
    "walletService": "ok",
    "sorobanRpc": "ok",
    "checkedAt": "2026-06-30T12:00:00.000Z"
  },
  "error": null
}
```

Each dependency reports `"ok"` or `"degraded"`. An unavailable Soroban RPC returns `"degraded"` without failing the endpoint.

## Testing

```bash
# Run tests once
pnpm --filter @delegolabs/payments test

# Watch mode
pnpm --filter @delegolabs/payments exec vitest watch
```

## Environment Configuration

```bash
# Network selection (default: testnet)
STELLAR_NETWORK=testnet|mainnet|futurenet

# Horizon endpoint (optional, uses intelligent defaults)
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org

# Wallet service endpoint
WALLET_URL=http://localhost:3012

# PostgreSQL (processed contract events / payment records / funding locks)
DATABASE_URL=postgresql://delego:delego@localhost:5432/delego

# Redis URL for streaming events and funding locks
REDIS_URL=redis://localhost:6379

# Escrow Funding Lock TTL in milliseconds (default: 30000)
ESCROW_LOCK_TTL_MS=30000

# Soroban RPC (escrow contract reads; optional, network-aware default)
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org

# Currency conversion rate cache (Issue #379)
EXCHANGE_RATE_CACHE_TTL_SECONDS=300
EXCHANGE_RATE_STALE_TTL_SECONDS=86400
EXCHANGE_RATE_REFRESH_INTERVAL_SECONDS=300
EXCHANGE_RATE_PAIRS=USD/XLM,EUR/XLM,USD/BTC,USD/ETH,USD/USDC
EXCHANGE_RATE_CIRCUIT_BREAKER_FAILURE_THRESHOLD=5
EXCHANGE_RATE_CIRCUIT_BREAKER_RECOVERY_TIMEOUT_MS=30000
EXCHANGE_RATE_CIRCUIT_BREAKER_HALF_OPEN_SUCCESS=2
ENABLE_EXCHANGE_RATE_CACHE=true
```

## Architecture

- **escrow/**: Escrow contract interactions and fee management
  - `feeEstimator.ts`: Dynamic fee fetching from Horizon
  - `wallet-client.ts`: Wallet service integration
  - `FEE_ESTIMATION.md`: Comprehensive fee estimation guide
- **events/**: Event-driven payment workflows
- **settlement/**: Settlement and reconciliation logic
- **src/**: Core payment service logic and HTTP route handlers
  - `validation.ts`: Escrow funding lock definitions (`acquireLock`, `releaseLock`, `EscrowFundingLock`) and payload validators
  - `routes.ts`: Payment routes with 409 `DUPLICATE_FUNDING_REQUEST` concurrency protections

### Currency Conversion Rate Cache with Circuit Breaker (Issue #379)

Caches fiat-to-crypto exchange rates in Redis with automatic fallback to
last known good rates when the rate oracle API is unreachable.

- **Redis-backed cache**: each pair is stored twice —
  `exchange:rate:<BASE>:<QUOTE>` (fresh copy, short TTL) and
  `exchange:rate:last-good:<BASE>:<QUOTE>` (stale fallback copy, long TTL).
- **Circuit breaker**: oracle refreshes run through
  `src/exchangeRate/circuitBreaker.ts` (closed → open → half-open, same
  pattern as the Soroban RPC breaker); an open circuit short-circuits
  oracle calls instead of stalling reads.
- **Stale fallback**: when the oracle fails (or the circuit is open) reads
  degrade to the last known good rate, flagged `stale: true`, rather than
  erroring — payments keep working through oracle outages.
- **Background refresh**: `startRateRefreshScheduler()` keeps the configured
  `EXCHANGE_RATE_PAIRS` warm on `EXCHANGE_RATE_REFRESH_INTERVAL_SECONDS`.
- **HTTP API**: `GET /exchange-rates/:base/:quote`,
  `POST /exchange-rates/:base/:quote/refresh`,
  `GET /exchange-rates/health`.


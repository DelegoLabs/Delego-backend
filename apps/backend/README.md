# Backend Services

This directory contains the backend microservices that power the Delego platform. Each service is independently deployable and exposes a health check endpoint.

## 📋 Table of Contents

- [Overview](#overview)
- [Services](#services)
- [Architecture](#architecture)
- [Development](#development)
- [Service Communication](#service-communication)
- [Monitoring](#monitoring)
- [Deployment](#deployment)

## Overview

The backend services directory contains microservices that implement the core business logic of the Delego platform. Each service is designed to be:

- **Independent**: Can be developed and deployed independently
- **Scalable**: Can scale horizontally based on demand
- **Resilient**: Handles failures gracefully
- **Observable**: Provides metrics and logging
- **Secure**: Implements proper security measures

### Service Principles

- **Single Responsibility**: Each service has a single, well-defined purpose
- **API-First**: Services expose well-defined APIs
- **Stateless**: Services are stateless where possible
- **Event-Driven**: Services communicate via events
- **Fail-Safe**: Services degrade gracefully on failure

## Services

### Gateway Service (`apps/backend/gateway`)

**Package**: `@delegolabs/gateway`
**Port**: 3000
**Health Check**: `GET /health`

The API gateway serves as the single entry point for all client requests.

#### Responsibilities

- HTTP API endpoint management
- JWT authentication and validation
- Role-based access control (RBAC)
- Wallet-based authorization
- Rate limiting and throttling
- Request routing to backend services
- API versioning
- Request/response logging
- CORS handling

#### Tech Stack

- Node.js with TypeScript (`@delegolabs/utils` HTTP server)
- JWT for authentication
- Redis for rate limiting
- PostgreSQL for user data

#### Endpoints

- `POST /api/v1/auth/register` - User registration
- `POST /api/v1/auth/login` - User authentication
- `POST /api/v1/auth/refresh` - Token refresh
- `POST /api/v1/auth/logout` - User logout
- `GET/POST /api/v1/delegations` - List / create delegations
- `GET/PATCH/DELETE /api/v1/delegations/:id` - Delegation detail / update / revoke
- `GET /api/v1/wallets/:walletId` - Wallet lookup
- `GET /api/v1/admin/rate-limit/metrics` - Rate-limit metrics
- `GET /api/v1/admin/circuit-breakers` - Circuit breaker status
- `GET /api/docs` - Swagger UI

#### Dynamic Rate Limiting for Unauthenticated Search

Public catalog search endpoints (e.g. `GET /api/v1/search`) are unauthenticated
and therefore rate limited per client IP using a Redis-backed token bucket to
prevent competitor data scraping.

Bucket state is stored in Redis under the key `ratelimit:search:{ip}` and follows
the `SearchRateLimitBucket` shape:

```typescript
export interface SearchRateLimitBucket {
  ip: string;
  remainingTokens: number;
  refillRatePerSec: number;
}
```

- Each IP starts with a full bucket of tokens and refills at `refillRatePerSec`.
- Every unauthenticated search request consumes one token.
- When `remainingTokens` reaches zero, the gateway responds with
  `429 Too Many Requests` and a standard `Retry-After` header indicating how
  many seconds until the next token is available.
- Buckets expire automatically once idle so Redis does not grow unbounded.

### Orchestrator Service (`apps/backend/orchestrator`)

**Package**: `@delegolabs/orchestrator`
**Port**: 3010
**Health Check**: `GET /health`

The orchestrator service coordinates purchase workflows across multiple services.

#### Responsibilities

- Purchase workflow coordination
- State machine management
- Event publishing/subscribing
- Service orchestration
- Workflow persistence
- Error handling and retries
- Timeout management

#### Workflow States

1. `INITIATED` - Order created by user
2. `SEARCHING` - Agent searching for products
3. `FOUND` - Products found, awaiting approval
4. `APPROVED` - User approved purchase
5. `ESCROW_FUNDED` - Funds locked in escrow
6. `PURCHASED` - Purchase completed
7. `DELIVERING` - Delivery in progress
8. `DELIVERED` - Delivery confirmed
9. `COMPLETED` - Order completed
10. `CANCELLED` - Order cancelled
11. `FAILED` - Order failed

#### Tech Stack

- Node.js with TypeScript
- Custom XState-style state machine (no external dependency)
- Event bus (Redis Pub/Sub)
- PostgreSQL for workflow persistence

### Wallet Service (`apps/backend/wallet`)

**Package**: `@delegolabs/wallet`
**Port**: 3012
**Health Check**: `GET /health`

The wallet service manages Stellar wallets and Soroban permissions.

#### Responsibilities

- Stellar account management
- Soroban permission grants
- Transaction signing
- Transaction submission
- Balance tracking
- Key management
- Soroban contract simulation

#### Security Features

- Encrypted key storage
- Hardware Security Module (HSM) integration (Planned)
- Multi-signature support (Planned)
- Session keys for delegated operations

#### Tech Stack

- Node.js with TypeScript
- Stellar SDK for JavaScript
- Soroban RPC client
- PostgreSQL for wallet data

### Payments Service (`apps/backend/payments`)

**Package**: `@delegolabs/payments`
**Port**: 3014
**Health Check**: `GET /health`

The payments service coordinates payment and escrow operations.

#### Responsibilities

- Escrow contract coordination
- Payment event processing
- Settlement execution
- Refund processing
- Payment status tracking
- Transaction monitoring

#### Payment Flow

1. User approves purchase
2. Wallet service signs transaction
3. Payments service funds escrow
4. Escrow contract locks funds
5. Delivery confirmed
6. Escrow releases funds to merchant
7. Settlement recorded

#### Tech Stack

- Node.js with TypeScript
- Soroban SDK
- Stellar SDK
- PostgreSQL for payment records

### Notifications Service (`apps/backend/notifications`)

**Package**: `@delegolabs/notifications`
**Port**: 3015
**Health Check**: `GET /health`

The notifications service sends customer-facing updates.

#### Responsibilities

- Email notifications
- Push notifications
- SMS notifications (Planned)
- Notification templates
- User preferences
- Delivery tracking
- Retry logic

#### Notification Types

- Order status updates
- Payment confirmations
- Approval requests
- Delivery notifications
- Security alerts

#### Tech Stack

- Node.js with TypeScript
- SendGrid for email
- Web Push API for push notifications
- Twilio for SMS (Planned)

### CDC Service (`apps/backend/cdc`)

**Package**: `@delegolabs/cdc`
**Port**: 3017
**Health Check**: `GET /health`

The CDC service implements Change Data Capture for real-time database
synchronization across services. It captures PostgreSQL row changes via native
logical replication (or an external Debezium cluster), transforms them into
domain events, and publishes them to the Redis bus with exactly-once delivery.

#### Responsibilities

- Capture INSERT / UPDATE / DELETE row changes from configured tables
- Transform raw WAL changes into canonical `CDCEvent`s and domain events
- Publish to Redis (durable stream `cdc:events` + real-time pub/sub fan-out)
- Exactly-once delivery via the `cdc_published_events` dedup table + durable
  replication checkpoints
- Schema evolution handling (`cdc_schema_versions`)
- Monitoring dashboard (`GET /cdc/dashboard`) showing WAL lag, throughput, and errors
- Failover / recovery by resuming from the durable slot checkpoint

#### Tech Stack

- Node.js with TypeScript
- PostgreSQL logical replication (native slots, `test_decoding`)
- Redis streams + pub/sub
- `@delegolabs/utils` HTTP server + metrics

#### Endpoints

- `GET /api/v1/cdc/metrics` - CDC `CDCMetrics` snapshot
- `GET /api/v1/cdc/position` - current WAL LSN + lag
- `GET /api/v1/cdc/config` - effective connector config (secrets redacted)
- `GET /cdc/dashboard` - HTML monitoring dashboard
- `GET /metrics` - Prometheus text metrics
- `POST /api/v1/cdc/pause` / `POST /api/v1/cdc/resume` - pipeline control

## Architecture

### Service Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      API Gateway                         │
│                   (Port 3000)                             │
└────────────────────┬────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
        v            v            v
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Orchestrator  │ │    Wallet    │ │   Payments   │
│  (Port 3010)  │ │  (Port 3012) │ │  (Port 3014)  │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │               │               │
       v               v               v
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│    Agents    │ │   Stellar    │ │   Soroban    │
│  (Port 3011)  │ │   Network    │ │   Contracts  │
└──────────────┘ └──────────────┘ └──────────────┘
```

### Service Dependencies

```
Gateway
  ├─> Orchestrator
  │    ├─> Agents
  │    

/* … truncated 5104 chars — edit only what you need near the top … */

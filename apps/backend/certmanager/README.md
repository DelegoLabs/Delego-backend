# @delegolabs/certmanager

Automated TLS certificate management for the Delego backend.

## Responsibilities

- **ACME integration** — issue certificates against Let's Encrypt, ZeroSSL, Buypass
  or a custom ACME directory (`CERT_ACME_PROVIDER`, `CERT_ACME_MODE=stub|http`).
- **Automatic renewal** — `RenewalScheduler` renews certificates when
  `nextRenewalAt` (computed as `notAfter - renewBeforeDays`) is reached. Defaults
  to renewing 30 days before expiry.
- **Certificate Transparency** — every issued certificate is submitted to the
  configured CT logs (`CERT_CT_LOG_URLS`).
- **Inventory & monitoring** — `GET /api/v1/certificates` lists the live inventory
  with recomputed status (`valid` / `expiring` / `expired` / `revoked` / `pending`)
  and `GET /api/v1/certificates/metrics` exposes `CertificateMetrics`.
- **Wildcard support** — wildcard domains require the `dns-01` challenge; the
  configured DNS provider (`cloudflare`, `route53`, `azure`, `google`) presents
  and cleans up the `_acme-challenge` TXT record.
- **Revocation** — `POST /api/v1/certificates/:id/revoke` revokes a certificate
  via the ACME client and marks it `revoked`.
- **Deployment automation** — issued/renewed certificates can be deployed to
  `nginx`, `haproxy`, `envoy` (PEM files) or a `webhook` target.
- **Storage key rotation (#400)** — dual-credential rotation of Cloudflare R2 /
  AWS S3 access keys every 90 days with zero downtime and key-expiry alerts
  (see below).
- **Storefront expiry monitoring** (Issue #390) — probes every registered
  merchant custom domain over a live TLS socket, computes `daysRemaining` and
  `isExpiringSoon`, and emits an alert **14 days before expiration** (plus on
  expiry and when a storefront becomes unreachable). Alerts go to the service
  log and optionally a webhook, with 24h per-domain dedupe.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CERTMANAGER_PORT` | `3020` | HTTP port |
| `CERT_ACME_MODE` | `stub` | `stub` (self-signed, offline) or `http` (real ACME) |
| `CERT_ACME_PROVIDER` | – | `letsencrypt` / `zerossl` / `buypass` / `custom` |
| `CERT_CT_ENABLED` | `true` | Submit certificates to CT logs |
| `CERT_CT_LOG_URLS` | Google + Cloudflare logs | Comma-separated CT log base URLs |
| `CERT_RENEWAL_INTERVAL_MS` | `43200000` | Scheduler interval (12h) |
| `CERT_RENEWAL_ENABLED` | `true` | Run the background renewal scheduler |
| `CERT_STORE` | `memory` | `memory` or `postgres` |
| `CERT_EXPIRY_ENABLED` | `true` | Run the background expiry checker (Issue #390) |
| `CERT_EXPIRY_INTERVAL_MS` | `43200000` | Expiry sweep interval (12h) |
| `CERT_EXPIRY_WARNING_DAYS` | `14` | Days before expiry at which alerts fire |
| `CERT_EXPIRY_DOMAINS` | – | JSON array of `{ merchantId, domain }` to monitor |
| `CERT_EXPIRY_WEBHOOK_URL` | – | POST target for expiry alerts (log sink is always on) |
| `CERT_EXPIRY_PROBE_PORT` | `443` | TLS port probed on merchant domains |
| `CERT_EXPIRY_PROBE_TIMEOUT_MS` | `10000` | Per-probe connect timeout |

### Storage key rotation (#400)

| Variable | Default | Description |
|---|---|---|
| `STORAGE_PRIMARY_KEY_ID` | – | Active R2/S3 access key id. **When unset, rotation is disabled.** |
| `STORAGE_PRIMARY_SECRET` | – | Active key secret |
| `STORAGE_SECONDARY_KEY_ID` | – | Incoming key id during a rotation window |
| `STORAGE_SECONDARY_SECRET` | – | Incoming key secret during a rotation window |
| `STORAGE_BINDING_ID` | `r2:delego-uploads` | Provider-scoped binding; the prefix (`r2`/`s3`) selects the provider |
| `STORAGE_BUCKET_NAME` | `delego-uploads` | Bucket the binding rotates against |
| `STORAGE_ROTATION_DAYS` | `90` | Rotation cadence in days |
| `STORAGE_ROTATION_GRACE_MS` | `86400000` | Grace period before the retiring key is revoked (24h) |
| `STORAGE_ROTATION_INTERVAL_MS` | `3600000` | Rotation scheduler tick (1h) |
| `STORAGE_KEY_WARN_DAYS` | `14` | Days before key expiry that a `warning` alert fires |
| `STORAGE_KEY_CRITICAL_DAYS` | `7` | Days before expiry that alerts escalate to `critical` |

## Storage key rotation (#400)

Object-storage access keys (Cloudflare R2 API tokens, AWS IAM keys) are rotated
every 90 days with **zero downtime** using dual-credential fallback:

1. `rotate()` creates an incoming key and installs it in the **secondary** slot
   — two independently-valid credentials now exist.
2. The incoming key is verified with a cheap provider call, then **promoted**
   to primary. The old key moves to secondary and enters a **grace period**
   (default 24h) during which in-flight requests signed with it keep succeeding.
3. After the grace period the old key is revoked and the secondary slot is
   cleared, leaving exactly one active key.

Every data-plane operation goes through `RotatingStorageClient.execute()`, which
tries the primary credential first and transparently retries **once** with the
secondary on auth failures (`InvalidAccessKeyId`, `SignatureDoesNotMatch`,
`AccessDenied`) — so an upload signed with a key that is retired mid-flight is
rescued instead of failing. Non-auth errors (e.g. `NoSuchKey`) surface
unchanged.

Key-expiry alerts (`evaluateAlerts()`, also emitted by the scheduler tick):

| Severity | Condition |
|---|---|
| `warning` | key expires within `STORAGE_KEY_WARN_DAYS` (14d) |
| `critical` | key expires within `STORAGE_KEY_CRITICAL_DAYS` (7d) |
| `critical` | key expired, or rotation overdue (past `nextRotationAt`) |
| `warning` | no secondary key staged as the rotation window approaches |

### Storage rotation API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/storage/rotation` | Rotation state (`phase`, `activeKeyId`, `nextRotationAt`) + metrics |
| `POST` | `/api/v1/storage/rotation` | Trigger a rotation now |
| `POST` | `/api/v1/storage/rotation/complete` | Revoke the retiring key early (e.g. compromise) |
| `GET` | `/api/v1/storage/rotation/alerts` | Current key-expiry alerts |

Shared types live in `@delegolabs/types` (`storageRotation.ts`):
`StorageCredentials`, `StorageKeyPair`, `StorageKeyRotation`,
`StorageKeyExpiryAlert` and friends.

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health`, `/health/ready`, `/health/metrics` | Health probes |
| `GET` | `/api/v1/certificates` | Certificate inventory |
| `POST` | `/api/v1/certificates` | Issue a certificate |
| `GET` | `/api/v1/certificates/:id` | Certificate detail |
| `POST` | `/api/v1/certificates/:id/renew` | Renew a certificate |
| `POST` | `/api/v1/certificates/:id/revoke` | Revoke a certificate |
| `POST` | `/api/v1/certificates/renewals` | Trigger due renewals |
| `GET` | `/api/v1/certificates/metrics` | Monitoring metrics |
| `GET` | `/api/v1/certificates/expiry` | Run an expiry sweep over all monitored domains |
| `GET` | `/api/v1/certificates/expiry/domains` | List monitored merchant domains |
| `POST` | `/api/v1/certificates/expiry/domains` | Register a `{ merchantId, domain }` for monitoring |
| `DELETE` | `/api/v1/certificates/expiry/domains/:domain` | Stop monitoring a domain |
| `GET` | `/api/v1/certificates/expiry/:domain` | Probe a single monitored domain now |
| `GET` | `/api/v1/storage/rotation` | Storage key rotation state + metrics |
| `POST` | `/api/v1/storage/rotation` | Trigger a storage key rotation |
| `POST` | `/api/v1/storage/rotation/complete` | Revoke the retiring storage key early |
| `GET` | `/api/v1/storage/rotation/alerts` | Storage key expiry alerts |

## Running

```bash
pnpm --filter @delegolabs/certmanager dev
pnpm --filter @delegolabs/certmanager test
```

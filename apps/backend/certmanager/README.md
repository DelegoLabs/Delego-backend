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

## Running

```bash
pnpm --filter @delegolabs/certmanager dev
pnpm --filter @delegolabs/certmanager test
```

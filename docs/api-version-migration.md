# API version migration guide

This document describes how clients should move between Delego API versions and how deprecation and sunset behavior works.

## Supported versions

- v1: deprecated, sunset date 2026-12-31
- v2: active, default version

## How to select a version

Clients may specify the version in one of three ways:

1. URL path
   - `GET /api/v2/status`
2. Accept header
   - `Accept: application/vnd.delego.v2+json`
3. Default fallback
   - If no version is specified, the gateway uses the latest active version (`v2`)

## Deprecation and sunset behavior

When a client calls a deprecated version, the response includes:

- `Deprecation: <RFC 1123 date>`
- `Sunset: <RFC 1123 date>`
- `Warning: 299 - "API version v1 is deprecated; upgrade to v2; sunset ..."`
- `X-API-Deprecated: true`

After the sunset date passes, requests for that version return:

- HTTP status `410 Gone`
- error code `API_VERSION_SUNSET`

## Migration from v1 to v2

### Recommended changes

- Update URL paths from `/api/v1/...` to `/api/v2/...`
- Or send `Accept: application/vnd.delego.v2+json`
- Validate any `Warning` or `Deprecation` headers introduced by upstream tooling

### Example

Before:

```bash
curl -H "Authorization: Bearer $TOKEN" https://api.delego.dev/api/v1/delegations
```

After:

```bash
curl -H "Authorization: Bearer $TOKEN" https://api.delego.dev/api/v2/delegations
```

Or via header:

```bash
curl \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.delego.v2+json" \
  https://api.delego.dev/api/delegations
```

## Compatibility notes

- v1 and v2 are treated as compatible in the compatibility matrix
- The gateway will not silently break the contract within a version
- A version that is deprecated but still active continues to work until its sunset date

## Operational guidance

- Monitor `Deprecation` and `Warning` headers in client logs
- Schedule upgrades before the sunset date
- Treat `410 Gone` as a hard removal signal

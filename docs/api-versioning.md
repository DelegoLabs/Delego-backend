# API Versioning Guide

This document describes how the Delego Gateway handles API versioning, how clients should specify a version, and how to migrate between versions.

## Overview

The gateway supports multiple concurrent API versions. Each version has a lifecycle:

| Status | Meaning |
|---|---|
| `active` | Fully supported, recommended for all new integrations |
| `deprecated` | Still served, but scheduled for retirement. Clients receive warning headers. |
| `sunset` | Retired. All requests return `410 Gone`. Migrate immediately. |

---

## Specifying a Version

Clients can specify the desired API version in three ways, evaluated in this priority order:

### 1. URL Path (recommended)

```
GET /api/v1/delegations
GET /api/v2/delegations
```

### 2. Accept Header (vendor media type)

```http
Accept: application/vnd.delego.v1+json
Accept: application/vnd.delego.v2+json
```

### 3. X-API-Version Header

```http
X-API-Version: v1
X-API-Version: v2
```

If no version is specified, the gateway defaults to the **latest active version**.

---

## Response Headers

Every response includes version metadata headers:

| Header | Description |
|---|---|
| `X-API-Version` | The resolved version used to serve the request |
| `X-API-Latest-Version` | The current latest active version |
| `X-API-Deprecated` | `"true"` when the resolved version is deprecated |
| `Deprecation` | ISO date when this version was declared deprecated |
| `Sunset` | ISO date when this version will stop being served |
| `X-API-Sunset` | Same as `Sunset` (additional header for compatibility) |
| `Warning` | RFC 9110 warning message describing the deprecation or retirement |

---

## Version Discovery

Query all registered versions and their statuses:

```http
GET /api/versions
```

Example response:

```json
{
  "data": {
    "latestVersion": "v1",
    "versions": [
      {
        "version": "v1",
        "status": "active",
        "releasedAt": "2026-01-01",
        "compatibleWith": []
      }
    ]
  },
  "error": null,
  "meta": {
    "requestId": "req_abc123",
    "timestamp": "2026-08-29T14:00:00.000Z"
  }
}
```

---

## Sunset Enforcement

When a version's `status` is `"sunset"`, all requests to that version return `410 Gone`:

```json
{
  "data": null,
  "error": {
    "code": "API_VERSION_GONE",
    "message": "API version v0 has been retired. Please migrate to v1.",
    "details": {
      "requestedVersion": "v0",
      "latestVersion": "v1",
      "sunsetAt": "2026-06-01"
    }
  },
  "meta": {
    "requestId": "req_abc123",
    "timestamp": "2026-08-29T14:00:00.000Z"
  }
}
```

The middleware rejects sunset requests before any authentication or business logic runs.

---

## Compatibility Matrix

| Version | Status | Released | Compatible With |
|---|---|---|---|
| `v1` | active | 2026-01-01 | — |

_This table is generated from the `VERSION_REGISTRY` in `src/versioning.ts`._

---

## Migration Guide: v1 → v2 (future)

> v2 has not been released yet. This section documents the planned migration path.

When v2 is released:

1. **Monitor deprecation headers** — once v1 is deprecated, responses will include `X-API-Deprecated: true` and a `Warning` header.
2. **Update the version specifier** — change `/api/v1/` to `/api/v2/` in all API calls (or update the `Accept` header).
3. **Review breaking changes** — see the changelog for the specific v2 release.
4. **Test against both versions** — use the `X-API-Version: v2` header to target v2 before updating path segments.
5. **Complete migration before the sunset date** — the `Sunset` header tells you the exact date.

### Example migration

Before (v1):

```http
GET /api/v1/delegations
Authorization: Bearer <token>
```

After (v2):

```http
GET /api/v2/delegations
Authorization: Bearer <token>
```

---

## Registering a New Version (for Gateway maintainers)

Add an entry to `VERSION_REGISTRY` in `apps/backend/gateway/src/versioning.ts`:

```ts
const VERSION_REGISTRY: ApiVersion[] = [
  {
    version: "v1",
    status: "active",
    releasedAt: "2026-01-01",
    compatibleWith: [],
  },
  // Add v2 when ready:
  {
    version: "v2",
    status: "active",
    releasedAt: "2026-12-01",
    compatibleWith: ["v1"],
  },
];
```

### Deprecating a version

1. Change `status` to `"deprecated"`.
2. Set `deprecatedAt` to today's ISO date.
3. Set `sunsetAt` to a date at least 6 months in the future.
4. Announce the sunset date in the changelog and notify API consumers.

```ts
{
  version: "v1",
  status: "deprecated",
  releasedAt: "2026-01-01",
  deprecatedAt: "2026-12-01",
  sunsetAt: "2027-06-01",
  compatibleWith: [],
}
```

### Sunsetting a version

1. Change `status` to `"sunset"`.
2. The middleware will automatically return `410 Gone` for all requests to this version.

---

## Adding Versioned Route Handlers

Use `buildVersionedRoutes` from `src/versionedRouter.ts` to register a handler for multiple versions:

```ts
import { buildVersionedRoutes, type VersionedRoute } from "../src/versionedRouter.js";

const myRoutes: VersionedRoute[] = [
  {
    path: "/api/:version/status",
    method: "GET",
    versions: ["v1", "v2"],
    handler: async (req, res, version) => {
      json(res, 200, { api: version, status: "ok" });
    },
  },
];

// In registerRoutes():
return [
  ...registerHealthRoutes(),
  versionDiscoveryRoute,
  ...buildVersionedRoutes(myRoutes),
  // …
];
```

`buildVersionedRoutes` automatically skips sunset versions and passes the resolved version slug to the handler.

---

## Implementation Reference

| File | Purpose |
|---|---|
| `src/versioning.ts` | Types, version registry, negotiation logic, header builder |
| `src/middleware/versioning.ts` | HTTP middleware: slug extraction, sunset enforcement, header injection |
| `src/versionedRouter.ts` | Expands `VersionedRoute[]` to `Route[]` for `startHttpServer` |
| `src/versioning.test.ts` | Unit tests for registry and negotiation |
| `src/versioning.middleware.test.ts` | Unit tests for middleware and versioned router |

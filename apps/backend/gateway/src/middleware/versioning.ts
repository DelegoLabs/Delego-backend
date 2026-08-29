/**
 * Version negotiation middleware for the Delego gateway.
 *
 * Reads the requested API version from (in priority order):
 *   1. URL path prefix  — /api/v1/…, /api/v2/…
 *   2. Accept header    — application/vnd.delego.v1+json
 *   3. X-API-Version header
 *
 * Falls back to the latest active version when none is specified.
 *
 * Attaches the negotiation result to the request via a WeakMap so that
 * downstream route handlers can read it with `getVersionContext(req)`.
 *
 * Enforces sunset versions: returns 410 Gone immediately.
 *
 * Issue #54
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import {
  negotiateVersion,
  parseVersionFromAcceptHeader,
  parseVersionSlug,
  buildVersionHeaders,
  isVersionSunset,
  getVersion,
  getAllVersions,
  getLatestActiveVersion,
  type VersionNegotiationResult,
} from "../versioning.js";
import { getRequestContext } from "../../middleware/requestId.js";

// ---------------------------------------------------------------------------
// Request context store
// ---------------------------------------------------------------------------

const versionContextMap = new WeakMap<IncomingMessage, VersionNegotiationResult>();

/** Retrieve the negotiated version context attached by the middleware. */
export function getVersionContext(req: IncomingMessage): VersionNegotiationResult | undefined {
  return versionContextMap.get(req);
}

// ---------------------------------------------------------------------------
// Version slug extraction
// ---------------------------------------------------------------------------

/** Extract a raw version slug from the request, or return null. */
function extractRequestedSlug(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  // 1. URL path: /api/v1/…  or  /v1/…
  const pathMatch = pathname.match(/(?:^|\/api)\/(v\d+)\//i);
  if (pathMatch) {
    const slug = parseVersionSlug(pathMatch[1]);
    if (slug) return slug;
  }

  // 2. Accept header: application/vnd.delego.v1+json
  const acceptHeader = req.headers["accept"];
  if (acceptHeader) {
    const slug = parseVersionFromAcceptHeader(acceptHeader);
    if (slug) return slug;
  }

  // 3. X-API-Version header
  const xApiVersion = req.headers["x-api-version"];
  if (typeof xApiVersion === "string") {
    const slug = parseVersionSlug(xApiVersion);
    if (slug) return slug;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export type NextFn = (err?: unknown) => void;

/**
 * Version negotiation middleware.
 *
 * Usage — pass the returned function in the `middleware` array to `startHttpServer`:
 *
 * ```ts
 * import { versionNegotiationMiddleware } from "./src/middleware/versioning.js";
 *
 * startHttpServer({
 *   middleware: [versionNegotiationMiddleware()],
 *   …
 * });
 * ```
 */
export function versionNegotiationMiddleware() {
  return (req: IncomingMessage, res: ServerResponse, next: NextFn): void => {
    const requestedSlug = extractRequestedSlug(req);

    // Enforce sunset: return 410 Gone before negotiation so handlers never run.
    if (requestedSlug && isVersionSunset(requestedSlug)) {
      const entry = getVersion(requestedSlug);
      const latest = getLatestActiveVersion();
      const requestId =
        getRequestContext(req)?.requestId ?? req.headers["x-request-id"] ?? "unknown";

      json(res, 410, {
        data: null,
        error: {
          code: "API_VERSION_GONE",
          message: `API version ${requestedSlug} has been retired. Please migrate to ${latest.version}.`,
          details: {
            requestedVersion: requestedSlug,
            latestVersion: latest.version,
            sunsetAt: entry?.sunsetAt,
          },
        },
        meta: {
          requestId,
          timestamp: new Date().toISOString(),
        },
      });
      return;
    }

    const result = negotiateVersion(requestedSlug);

    // Attach to request for downstream handlers.
    versionContextMap.set(req, result);

    // Write version headers on the response.
    const headers = buildVersionHeaders(result);
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Version discovery route handler
// ---------------------------------------------------------------------------

/**
 * Returns metadata about all registered API versions.
 *
 * Register as:  route("GET", "/api/versions", versionDiscoveryHandler)
 */
export function versionDiscoveryHandler(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const requestId =
    getRequestContext(req)?.requestId ?? req.headers["x-request-id"] ?? "unknown";

  const versions = getAllVersions().map((v) => ({
    version: v.version,
    status: v.status,
    releasedAt: v.releasedAt,
    ...(v.deprecatedAt ? { deprecatedAt: v.deprecatedAt } : {}),
    ...(v.sunsetAt ? { sunsetAt: v.sunsetAt } : {}),
    compatibleWith: v.compatibleWith,
  }));

  const latest = getLatestActiveVersion();

  json(res, 200, {
    data: {
      latestVersion: latest.version,
      versions,
    },
    error: null,
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  });
}

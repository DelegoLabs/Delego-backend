/**
 * Versioned router for the Delego gateway.
 *
 * A `VersionedRoute` declares which version slugs a handler supports.
 * `buildVersionedRoutes` expands each declaration into one or more `Route`
 * entries that the standard `startHttpServer` router can match.
 *
 * Handlers receive the resolved version slug as a third argument so they can
 * apply any per-version response shaping:
 *
 * ```ts
 * const myRoute: VersionedRoute = {
 *   path: "/api/:version/status",
 *   method: "GET",
 *   versions: ["v1", "v2"],
 *   handler: async (req, res, version) => {
 *     json(res, 200, { api: version });
 *   },
 * };
 * ```
 *
 * Issue #54
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { route } from "@delegolabs/utils";
import type { Route } from "@delegolabs/utils";
import {
  getVersionContext,
  versionDiscoveryHandler,
} from "./middleware/versioning.js";
import type { VersionedRoute } from "./versioning.js";
import { isVersionSupported } from "./versioning.js";

export type { VersionedRoute };

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

/**
 * Expand a list of `VersionedRoute` declarations into `Route[]` entries.
 *
 * For each (declaration × version) pair a concrete path is produced by
 * replacing the `:version` segment (if present) with the slug, or by
 * prepending `/api/<slug>` when the path already starts without a version
 * segment.
 *
 * Only versions listed in the declaration AND present in the registry as
 * non-sunset are registered.
 */
export function buildVersionedRoutes(declarations: VersionedRoute[]): Route[] {
  const routes: Route[] = [];

  for (const decl of declarations) {
    for (const slug of decl.versions) {
      if (!isVersionSupported(slug)) continue;

      const resolvedPath = resolvePath(decl.path, slug);

      routes.push(
        route(decl.method.toUpperCase(), resolvedPath, async (req, res, params) => {
          // Prefer the version the middleware already negotiated; fall back to
          // the slug baked into the concrete path so the handler always has one.
          const ctx = getVersionContext(req);
          const version = ctx?.version ?? slug;
          await decl.handler(req, res, version);
        }),
      );
    }
  }

  return routes;
}

/**
 * Substitute a version slug into a path template.
 *
 * Rules (in order):
 *   1. If the path contains a literal `:version` segment → replace it.
 *   2. If the path starts with `/api/v<digit>` → leave it as-is (already versioned).
 *   3. If the path starts with `/api/` → insert the slug: /api/v1/…
 *   4. Otherwise → prepend /api/<slug>
 */
export function resolvePath(pathTemplate: string, slug: string): string {
  if (pathTemplate.includes(":version")) {
    return pathTemplate.replace(":version", slug);
  }
  if (/^\/api\/v\d+/.test(pathTemplate)) {
    return pathTemplate;
  }
  if (pathTemplate.startsWith("/api/")) {
    return `/api/${slug}/${pathTemplate.slice(5)}`;
  }
  return `/api/${slug}${pathTemplate.startsWith("/") ? pathTemplate : `/${pathTemplate}`}`;
}

// ---------------------------------------------------------------------------
// Discovery route
// ---------------------------------------------------------------------------

/**
 * Pre-built `Route` for `GET /api/versions`.
 *
 * Spread into `registerRoutes()` alongside the versioned routes:
 *
 * ```ts
 * return [
 *   ...registerHealthRoutes(),
 *   versionDiscoveryRoute,
 *   ...buildVersionedRoutes(myRoutes),
 * ];
 * ```
 */
export const versionDiscoveryRoute: Route = route(
  "GET",
  "/api/versions",
  (req: IncomingMessage, res: ServerResponse) => {
    versionDiscoveryHandler(req, res);
  },
);

/**
 * Resolves a request's rate-limit tier (Issue #51).
 *
 * Tier is derived server-side from the verified JWT's roles — never from a
 * client-supplied header — except for `internal`, which requires a shared
 * secret meant for service-to-service calls (wallet/payments/orchestrator
 * hitting the gateway don't carry a user JWT at all).
 */

import type { IncomingMessage } from "node:http";
import { getAuthenticatedUserContext } from "../../../middleware/auth.js";
import type { RateLimitTier } from "./types.js";

const INTERNAL_SERVICE_HEADER = "x-internal-service-key";

function hasRole(roles: string[] | undefined, role: string): boolean {
  return roles?.includes(role) ?? false;
}

export function resolveTier(req: IncomingMessage): RateLimitTier {
  const internalKey = process.env.INTERNAL_SERVICE_KEY;
  if (internalKey) {
    const provided = req.headers[INTERNAL_SERVICE_HEADER];
    if (provided === internalKey) {
      return "internal";
    }
  }

  const ctx = getAuthenticatedUserContext(req);
  if (hasRole(ctx?.roles, "internal")) return "internal";
  if (hasRole(ctx?.roles, "enterprise")) return "enterprise";
  if (hasRole(ctx?.roles, "pro")) return "pro";

  return "free";
}

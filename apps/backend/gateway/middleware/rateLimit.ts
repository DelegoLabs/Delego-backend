import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import { resolveTier } from "../src/rateLimit/tokenBucket/tierResolver.js";
import { resolveTenantTier } from "../src/rateLimit/tenantTiers.js";
import { TenantRateLimiter } from "../src/rateLimit/tenantRateLimiter.js";
import { extractAuth, getAuthenticatedUserContext } from "./auth.js";
import type { RateLimitConfig as LegacyRateLimitConfig } from "../src/rateLimit/types.js";
import { checkRateLimit as legacyCheckRateLimit } from "../src/rateLimit/rateLimiter.js";

function getIdentifier(req: IncomingMessage): string {
  const auth = extractAuth(req);
  if (auth.userId) {
    return auth.userId;
  }

  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }

  return req.socket.remoteAddress ?? "unknown";
}

function getEndpoint(req: IncomingMessage): { method: string; path: string } {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  return { method, path: url.pathname };
}

export interface RateLimitMiddlewareOptions {
  /** Injected tenant limiter (tests); defaults to a Redis-backed instance. */
  tenantLimiter?: TenantRateLimiter;
}

/**
 * Tiered rate limiting (Issue #309).
 *
 * Tenant tiers are enforced with a Redis sliding-window log maintained by
 * `TenantRateLimiter` — Free 60/min, Merchant 300/min, Enterprise 1200/min,
 * each with a burst allowance. Responses carry `X-RateLimit-Limit`,
 * `X-RateLimit-Remaining`, and (on HTTP 429) an exact `Retry-After` in
 * seconds. Internal service-to-service callers stay exempt, and the legacy
 * `{ maxRequests, windowMs }` override still uses the fixed-window limiter.
 *
 * `getIdentifier` calls `extractAuth` first so tier resolution (which reads
 * the authenticated-user context `extractAuth` populates) sees the caller's
 * verified roles rather than defaulting everyone to "free".
 */
export function rateLimitMiddleware(
  overrideConfig?: LegacyRateLimitConfig,
  options: RateLimitMiddlewareOptions = {}
) {
  let tenantLimiter = options.tenantLimiter;
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: any) => void
  ): Promise<void> => {
    try {
      const { method, path } = getEndpoint(req);
      if (method === "GET" && path === "/health") {
        next();
        return;
      }

      const identifier = getIdentifier(req);

      if (overrideConfig) {
        const legacyResult = await legacyCheckRateLimit(
          identifier,
          `${method}:${path}`,
          overrideConfig,
        );

        res.setHeader("RateLimit-Limit", legacyResult.limit);
        res.setHeader("RateLimit-Remaining", legacyResult.remaining);
        res.setHeader("RateLimit-Reset", legacyResult.resetInSeconds);

        if (!legacyResult.allowed) {
          res.setHeader("Retry-After", legacyResult.resetInSeconds);
          json(res, 429, {
            data: null,
            error: {
              code: "RATE_LIMIT_EXCEEDED",
              message: `Rate limit exceeded. Please retry after ${legacyResult.resetInSeconds} seconds.`,
            },
          });
          return;
        }

        next();
        return;
      }

      // Internal service-to-service callers are exempt from tenant limits.
      if (resolveTier(req) === "internal") {
        next();
        return;
      }

      const tier = resolveTenantTier(getAuthenticatedUserContext(req)?.roles);
      tenantLimiter ??= new TenantRateLimiter();
      const decision = await tenantLimiter.check(identifier, tier, { endpoint: path, method });

      for (const [name, value] of Object.entries(decision.headers)) {
        res.setHeader(name, value);
      }

      if (!decision.allowed) {
        json(res, 429, {
          data: null,
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: `Rate limit exceeded for tier "${decision.tier}". Please retry after ${decision.retryAfterSeconds} seconds.`,
          },
        });
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

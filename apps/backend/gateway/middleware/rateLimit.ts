import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import { checkRateLimit } from "../src/rateLimit/tokenBucket/limiter.js";
import { resolveTier } from "../src/rateLimit/tokenBucket/tierResolver.js";
import { extractAuth } from "./auth.js";
import type { RateLimitConfig, RateLimitKey } from "../src/rateLimit/tokenBucket/types.js";

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

/**
 * Tiered token-bucket rate limiting (Issue #51).
 *
 * `getIdentifier` calls `extractAuth` first so `resolveTier` (which reads
 * the authenticated-user context `extractAuth` populates) sees the caller's
 * verified roles rather than defaulting everyone to "free".
 */
export function rateLimitMiddleware(overrideConfig?: RateLimitConfig) {
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
      const tier = resolveTier(req);

      const key: RateLimitKey = { identifier, tier, endpoint: path, method };
      const result = await checkRateLimit(key, overrideConfig);

      res.setHeader("RateLimit-Limit", result.limit);
      res.setHeader("RateLimit-Remaining", result.remaining);
      res.setHeader("RateLimit-Reset", result.resetAt);

      if (!result.allowed) {
        const retryAfterSeconds = Math.ceil((result.retryAfterMs ?? 1000) / 1000);
        res.setHeader("Retry-After", retryAfterSeconds);
        json(res, 429, {
          data: null,
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: `Rate limit exceeded for tier "${tier}". Please retry after ${retryAfterSeconds} seconds.`,
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

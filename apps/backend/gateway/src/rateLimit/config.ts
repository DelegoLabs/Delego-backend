import type { RateLimitConfig } from "./types.js";

/**
 * Base rules, overridable per-route via env vars (see `withEnvOverrides`
 * below) — e.g. `RATE_LIMIT_GET_MAX=200` and `RATE_LIMIT_GET_WINDOW_MS=60000`
 * for the `GET:*` rule, or `RATE_LIMIT_DEFAULT_MAX` / `RATE_LIMIT_DEFAULT_WINDOW_MS`
 * for the catch-all `*` rule (issue #26).
 */
const BASE_RATE_LIMIT_RULES: Record<string, RateLimitConfig> = {
  "POST:/api/v1/auth/login":    { maxRequests: 5,   windowMs: 60000  },
  "POST:/api/v1/auth/register": { maxRequests: 3,   windowMs: 300000 },
  "POST:/api/v1/delegations":   { maxRequests: 20,  windowMs: 60000  },
  "POST:/api/v1/orders":        { maxRequests: 30,  windowMs: 60000  },
  "GET:*":                      { maxRequests: 100, windowMs: 60000  },
  "*":                          { maxRequests: 60,  windowMs: 60000  },
};

const BASE_DEFAULT_RATE_LIMIT: RateLimitConfig = { maxRequests: 60, windowMs: 60000 };

/**
 * Maps a rule key to the env var prefix used to override it, e.g.
 * `GET:*` -> `RATE_LIMIT_GET`, `*` -> `RATE_LIMIT_DEFAULT`,
 * `POST:/api/v1/auth/login` -> `RATE_LIMIT_POST_API_V1_AUTH_LOGIN`.
 */
function envPrefixFor(ruleKey: string): string {
  if (ruleKey === "*") return "RATE_LIMIT_DEFAULT";
  const normalized = ruleKey
    .replace(/:\*$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `RATE_LIMIT_${normalized}`;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function withEnvOverrides(ruleKey: string, base: RateLimitConfig): RateLimitConfig {
  const prefix = envPrefixFor(ruleKey);
  const maxRequests = parsePositiveInt(process.env[`${prefix}_MAX`]);
  const windowMs = parsePositiveInt(process.env[`${prefix}_WINDOW_MS`]);
  if (maxRequests === undefined && windowMs === undefined) return base;
  return {
    ...base,
    ...(maxRequests !== undefined ? { maxRequests } : {}),
    ...(windowMs !== undefined ? { windowMs } : {}),
  };
}

/**
 * Rebuilds the rule table from `process.env` on every access rather than
 * caching it at module-load time, so tests (and runtime env changes) don't
 * need to reload the module to see updated overrides.
 */
export function getRateLimitRules(): Record<string, RateLimitConfig> {
  const rules: Record<string, RateLimitConfig> = {};
  for (const [key, base] of Object.entries(BASE_RATE_LIMIT_RULES)) {
    rules[key] = withEnvOverrides(key, base);
  }
  return rules;
}

export function getDefaultRateLimit(): RateLimitConfig {
  return withEnvOverrides("*", BASE_DEFAULT_RATE_LIMIT);
}

/** @deprecated Use `getRateLimitRules()` — this snapshot does not reflect env overrides set after module load. */
export const RATE_LIMIT_RULES: Record<string, RateLimitConfig> = BASE_RATE_LIMIT_RULES;

/** @deprecated Use `getDefaultRateLimit()` — this snapshot does not reflect env overrides set after module load. */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = BASE_DEFAULT_RATE_LIMIT;

export function getRateLimitConfig(method: string, path: string): RateLimitConfig {
  const rules = getRateLimitRules();

  const exactKey = `${method}:${path}`;
  if (rules[exactKey]) {
    return rules[exactKey];
  }

  const methodGlob = `${method}:*`;
  if (rules[methodGlob]) {
    return rules[methodGlob];
  }

  if (rules["*"]) {
    return rules["*"];
  }

  return getDefaultRateLimit();
}

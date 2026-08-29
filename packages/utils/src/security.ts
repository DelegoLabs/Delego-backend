/**
 * #80 — CORS and security-header middleware, shared across every backend
 * service. Each service opts in by adding `corsMiddleware()` and
 * `securityHeadersMiddleware()` to its `startHttpServer({ middleware })`
 * array — see gateway/src/index.ts for the reference wiring.
 *
 * No Express/helmet in this stack (see packages/utils/src/http.ts) — these
 * are plain `(req, res, next) => void` functions written against the same
 * hand-rolled middleware contract every other middleware in this repo uses
 * (requestId, compression, rateLimit).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "./logger.js";

const log = createLogger("security");

// ─── CORS ───────────────────────────────────────────────────────────────────

export interface CorsRejectionLog {
  requestId?: string;
  origin: string;
  path: string;
  rejectedAt: string;
}

export interface CorsOptions {
  /** Comma-separated allowlist, e.g. from CORS_ORIGIN. Defaults to reading process.env.CORS_ORIGIN. */
  allowedOrigins?: string[];
  allowedMethods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  /** Access-Control-Max-Age, in seconds — how long a browser may cache a preflight response. */
  maxAgeSeconds?: number;
}

const DEFAULT_DEV_ORIGINS = ["http://localhost:3001", "http://localhost:3002"];
const DEFAULT_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const DEFAULT_HEADERS = ["Content-Type", "Authorization", "X-Request-Id"];
const DEFAULT_MAX_AGE_SECONDS = 600; // 10 minutes — bounds how stale a cached preflight can get

/**
 * Resolves the effective allowed-origins list.
 *
 * Production never falls back to a wildcard or the dev localhost list — an
 * unset CORS_ORIGIN in production means "reject every cross-origin request"
 * rather than silently allowing one, matching the acceptance criterion
 * "CORS blocks unauthorized origins" over convenience.
 */
function resolveAllowedOrigins(explicit?: string[]): string[] {
  if (explicit) return explicit;

  const configured = process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()).filter(Boolean);
  if (configured && configured.length > 0) return configured;

  const nodeEnv = process.env.NODE_ENV ?? "development";
  return nodeEnv === "production" ? [] : DEFAULT_DEV_ORIGINS;
}

function logRejectedOrigin(req: IncomingMessage, origin: string): void {
  const entry: CorsRejectionLog = {
    origin,
    path: (req.url ?? "").split("?")[0],
    rejectedAt: new Date().toISOString(),
  };
  log.warn("CORS origin rejected", { ...entry });
}

/**
 * CORS middleware: sets Access-Control-* headers for allowed origins,
 * logs (and does not set the allow header for) rejected origins, and
 * short-circuits OPTIONS preflight requests with 204 rather than passing
 * them down the middleware chain to a route that won't handle OPTIONS.
 */
export function corsMiddleware(options: CorsOptions = {}) {
  const allowed = resolveAllowedOrigins(options.allowedOrigins);
  const methods = options.allowedMethods ?? DEFAULT_METHODS;
  const headers = options.allowedHeaders ?? DEFAULT_HEADERS;
  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;

  return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void => {
    const requestOrigin = req.headers.origin ?? "";
    const isAllowed = requestOrigin !== "" && allowed.includes(requestOrigin);

    if (isAllowed) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Vary", "Origin");
      if (options.credentials) {
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
      if (options.exposedHeaders?.length) {
        res.setHeader("Access-Control-Expose-Headers", options.exposedHeaders.join(", "));
      }
    } else if (requestOrigin) {
      logRejectedOrigin(req, requestOrigin);
    }

    res.setHeader("Access-Control-Allow-Methods", methods.join(", "));
    res.setHeader("Access-Control-Allow-Headers", headers.join(", "));
    res.setHeader("Access-Control-Max-Age", String(maxAge));

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    next();
  };
}

// ─── Security headers ───────────────────────────────────────────────────────

export interface SecurityHeadersOptions {
  /**
   * Content-Security-Policy directives. Values are space-joined per
   * directive, directives are semicolon-joined. Defaults to a conservative
   * API-service policy (no inline scripts/styles need to be allowed since
   * these backend services never render HTML — see DEFAULT_CSP_DIRECTIVES).
   */
  cspDirectives?: Record<string, string[]>;
  /**
   * When true (the default), CSP is sent as
   * `Content-Security-Policy-Report-Only` instead of the enforcing header —
   * per the issue's "Test CSP with report-only mode first" requirement.
   * Flip to false only after confirming report-only mode produces no
   * unexpected violations.
   */
  cspReportOnly?: boolean;
  /** Where the browser should POST CSP violation reports, if anywhere. */
  cspReportUri?: string;
  frameOptions?: "DENY" | "SAMEORIGIN";
  /** Only set when the service is actually served over HTTPS — HSTS on an HTTP-only origin is a footgun. */
  hstsEnabled?: boolean;
  hstsMaxAgeSeconds?: number;
}

// These backend services are JSON APIs, never HTML-rendering — so the
// policy denies everything by default rather than needing 'unsafe-inline'
// exceptions a frontend template would.
const DEFAULT_CSP_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'none'"],
  "frame-ancestors": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
};

const DEFAULT_HSTS_MAX_AGE_SECONDS = 15552000; // 180 days — under the ≥1 year eligibility

function buildCsp(directives: Record<string, string[]>, reportUri?: string): string {
  const parts = Object.entries(directives).map(([key, values]) => `${key} ${values.join(" ")}`);
  if (reportUri) {
    parts.push(`report-uri ${reportUri}`);
  }
  return parts.join("; ");
}

/**
 * Security-headers middleware: CSP (report-only by default), X-Frame-Options,
 * X-Content-Type-Options, Referrer-Policy, Permissions-Policy, and — when
 * the service is confirmed to run over HTTPS — HSTS and cross-origin
 * isolation headers (COOP/COEP/CORP).
 */
export function securityHeadersMiddleware(options: SecurityHeadersOptions = {}) {
  const directives = options.cspDirectives ?? DEFAULT_CSP_DIRECTIVES;
  const reportOnly = options.cspReportOnly ?? true;
  const frameOptions = options.frameOptions ?? "DENY";
  const hstsEnabled = options.hstsEnabled ?? false;
  const hstsMaxAge = options.hstsMaxAgeSeconds ?? DEFAULT_HSTS_MAX_AGE_SECONDS;

  const cspHeaderName = reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
  const cspValue = buildCsp(directives, options.cspReportUri);

  return (_req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void => {
    res.setHeader(cspHeaderName, cspValue);
    res.setHeader("X-Frame-Options", frameOptions);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    // Deny every browser-feature permission by default — a JSON API has no
    // use for camera/mic/geolocation and denying them costs nothing.
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    );
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    // COEP is opt-in (via hstsEnabled's HTTPS-confirmed gate, reused here)
    // because it can break cross-origin subresource loading if any client
    // depends on unmarked third-party resources — safer to enable it only
    // once HTTPS (and therefore the production topology) is confirmed.
    if (hstsEnabled) {
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      res.setHeader(
        "Strict-Transport-Security",
        `max-age=${hstsMaxAge}; includeSubDomains; preload`
      );
    }

    next();
  };
}

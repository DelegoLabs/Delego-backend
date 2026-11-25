/**
 * Strict JSON payload limiter and prototype-pollution guard (Issue #615).
 *
 * Two independent protections, both applied while reading an incoming
 * request body:
 *
 *  1. A strict byte-size cap — enforced per-chunk (not after buffering the
 *     whole body) so an oversized payload is rejected without ever holding
 *     it all in memory, the same approach `../../routes/api-v1.ts`'s
 *     `bodyLimitMiddleware` uses for API v1 size limits.
 *  2. A custom `JSON.parse` reviver that recursively rejects (or, if
 *     configured, strips) `__proto__`, `constructor`, and `prototype` keys
 *     — the keys a prototype-pollution payload uses to reach into
 *     `Object.prototype` and corrupt every object in the process.
 *
 * Usage: either call `readSanitizedJsonBody` directly from a route handler
 * (this codebase's handlers each parse their own body — see
 * `packages/utils/src/http.ts`'s `readBodyWithLimit` and its callers —
 * there is no single body-parsing choke point to hook a traditional
 * Express/Fastify middleware into), or use `jsonSanitizerMiddleware` where a
 * handler is comfortable reading `(req as any).sanitizedBody` instead of
 * parsing the body itself.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { badRequest, payloadTooLarge } from "../errors.js";

/** The keys a prototype-pollution payload uses to reach `Object.prototype`. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const DEFAULT_MAX_SIZE_BYTES = 1024 * 1024; // 1MB — standard endpoints
export const DEFAULT_UPLOAD_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB — file upload endpoints

export interface SanitizedJsonOptions {
  maxSizeBytes: number;
  stripPrototypeKeys: boolean;
}

export const DEFAULT_SANITIZED_JSON_OPTIONS: SanitizedJsonOptions = {
  maxSizeBytes: DEFAULT_MAX_SIZE_BYTES,
  stripPrototypeKeys: false,
};

export class PrototypePollutionError extends Error {
  constructor(public readonly key: string) {
    super(`Payload contains a disallowed key: "${key}"`);
    this.name = "PrototypePollutionError";
  }
}

export class JsonPayloadTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`JSON body exceeds the ${limitBytes}-byte limit`);
    this.name = "JsonPayloadTooLargeError";
  }
}

/**
 * Builds a `JSON.parse` reviver that recursively guards against prototype
 * pollution. When `stripPrototypeKeys` is true, offending keys are simply
 * dropped (returning `undefined` from a reviver deletes that key); when
 * false, the first offending key throws `PrototypePollutionError`, which
 * aborts the whole parse — a payload containing a pollution attempt is
 * refused entirely rather than partially accepted.
 */
export function createPrototypeGuardReviver(
  stripPrototypeKeys: boolean
): (key: string, value: unknown) => unknown {
  return (key: string, value: unknown): unknown => {
    if (DANGEROUS_KEYS.has(key)) {
      if (stripPrototypeKeys) return undefined;
      throw new PrototypePollutionError(key);
    }
    return value;
  };
}

/**
 * Parses `raw` JSON text, rejecting (or stripping) prototype-pollution keys
 * at every nesting level via `JSON.parse`'s reviver callback, which visits
 * every key in the tree bottom-up.
 */
export function parseSanitizedJson(
  raw: string,
  options: Partial<SanitizedJsonOptions> = {}
): unknown {
  const stripPrototypeKeys = options.stripPrototypeKeys ?? DEFAULT_SANITIZED_JSON_OPTIONS.stripPrototypeKeys;
  return JSON.parse(raw, createPrototypeGuardReviver(stripPrototypeKeys));
}

/**
 * Reads the request body with a strict per-chunk byte limit, then parses it
 * with the prototype-pollution guard. Throws `JsonPayloadTooLargeError` or
 * `PrototypePollutionError` on violation (map these to HTTP 413 / 400
 * respectively — `jsonSanitizerMiddleware` below does this for callers that
 * want the middleware form instead).
 */
export function readSanitizedJsonBody(
  req: IncomingMessage,
  options: Partial<SanitizedJsonOptions> = {}
): Promise<unknown> {
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_SANITIZED_JSON_OPTIONS.maxSizeBytes;

  return new Promise((resolve, reject) => {
    let body = "";
    let bytesRead = 0;
    let rejected = false;

    const onData = (chunk: Buffer | string) => {
      if (rejected) return;

      bytesRead += Buffer.byteLength(chunk);
      if (bytesRead > maxSizeBytes) {
        rejected = true;
        req.removeListener("data", onData);
        req.removeListener("end", onEnd);
        req.removeListener("error", onError);
        reject(new JsonPayloadTooLargeError(maxSizeBytes));
        return;
      }

      body += chunk;
    };

    const onEnd = () => {
      if (rejected) return;
      try {
        resolve(parseSanitizedJson(body || "null", options));
      } catch (err) {
        reject(err);
      }
    };

    const onError = (err: Error) => {
      if (rejected) return;
      reject(err);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/** Default rule for which endpoints get the larger (10MB) upload limit. */
export function isUploadPath(pathname: string): boolean {
  return /\/(upload|uploads|import|bulkImport|media)(\/|$)/i.test(pathname);
}

function getRequestPathname(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  return url.pathname;
}

/**
 * Middleware form: reads + sanitizes the JSON body and attaches the parsed
 * result to `(req as any).sanitizedBody` for downstream handlers, choosing
 * the 1MB/10MB size limit by path (`isUploadPath`). On violation, responds
 * 413 (oversized) or 400 (prototype pollution attempt) and does not call
 * `next()`.
 */
export function jsonSanitizerMiddleware(
  overrides: Partial<SanitizedJsonOptions> & { uploadMaxSizeBytes?: number } = {}
) {
  const standardMaxBytes = overrides.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const uploadMaxBytes = overrides.uploadMaxSizeBytes ?? DEFAULT_UPLOAD_MAX_SIZE_BYTES;
  const stripPrototypeKeys = overrides.stripPrototypeKeys ?? false;

  return async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): Promise<void> => {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "POST" && method !== "PUT" && method !== "PATCH") {
      next();
      return;
    }

    const pathname = getRequestPathname(req);
    const maxSizeBytes = isUploadPath(pathname) ? uploadMaxBytes : standardMaxBytes;

    try {
      const sanitizedBody = await readSanitizedJsonBody(req, { maxSizeBytes, stripPrototypeKeys });
      (req as IncomingMessage & { sanitizedBody?: unknown }).sanitizedBody = sanitizedBody;
      next();
    } catch (err) {
      if (err instanceof JsonPayloadTooLargeError) {
        payloadTooLarge(res, `JSON body exceeds limit of ${err.limitBytes} bytes`, req, {
          maxSizeBytes,
        });
        return;
      }
      if (err instanceof PrototypePollutionError) {
        badRequest(res, "Payload contains a disallowed key", req, { key: err.key });
        return;
      }
      // Any other parse error (malformed JSON, etc.) is also a client error.
      badRequest(res, "Malformed JSON payload", req);
    }
  };
}

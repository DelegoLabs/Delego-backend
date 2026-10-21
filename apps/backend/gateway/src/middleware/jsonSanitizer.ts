/**
 * Strict JSON Payload Limiter and Prototype Pollution Guard
 * 
 * Issue #615: Enforces strict body size limits (1MB default, 10MB upload)
 * and guards against prototype pollution attacks (__proto__, constructor, prototype).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export interface SanitizedJsonOptions {
  maxSizeBytes?: number;
  stripPrototypeKeys?: boolean;
}

export const DEFAULT_JSON_SIZE_LIMIT_BYTES = 1024 * 1024; // 1MB
export const UPLOAD_JSON_SIZE_LIMIT_BYTES = 10 * 1024 * 1024; // 10MB

export const FORBIDDEN_PROTOTYPE_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export class PrototypePollutionError extends Error {
  public readonly statusCode = 400;
  public readonly key: string;
  constructor(key: string) {
    super(`Prototype pollution attempt detected: forbidden key "${key}"`);
    this.name = "PrototypePollutionError";
    this.key = key;
  }
}

export class PayloadTooLargeError extends Error {
  public readonly statusCode = 413;
  public readonly sizeBytes: number;
  public readonly limitBytes: number;
  constructor(sizeBytes: number, limitBytes: number) {
    super(`Payload Too Large: size ${sizeBytes} bytes exceeds limit of ${limitBytes} bytes`);
    this.name = "PayloadTooLargeError";
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
}

/**
 * Custom JSON reviver that recursively rejects or deletes forbidden prototype keys.
 */
export function prototypeSanitizingReviver(stripPrototypeKeys: boolean = false) {
  return function (key: string, value: unknown): unknown {
    if (FORBIDDEN_PROTOTYPE_KEYS.has(key)) {
      if (stripPrototypeKeys) {
        return undefined; // deleting key from object
      }
      throw new PrototypePollutionError(key);
    }
    return value;
  };
}

/**
 * Parses JSON with strict size limiting and prototype pollution protection.
 */
export function parseSanitizedJson<T = unknown>(
  rawText: string,
  options?: SanitizedJsonOptions
): T {
  const maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_JSON_SIZE_LIMIT_BYTES;
  const byteLength = Buffer.byteLength(rawText);

  if (byteLength > maxSizeBytes) {
    throw new PayloadTooLargeError(byteLength, maxSizeBytes);
  }

  const strip = options?.stripPrototypeKeys ?? false;
  return JSON.parse(rawText, prototypeSanitizingReviver(strip));
}

/**
 * HTTP Middleware for Express / native http / Fastify gateway integration.
 */
export function jsonSanitizerMiddleware(options?: SanitizedJsonOptions) {
  return async function (
    req: IncomingMessage & { body?: any },
    res: ServerResponse,
    next: (err?: any) => void
  ): Promise<void> {
    const isUpload = req.url ? /\/(upload|file|files|media|attachments)(\/|\?|$)/i.test(req.url) : false;
    const limit = options?.maxSizeBytes ?? (isUpload ? UPLOAD_JSON_SIZE_LIMIT_BYTES : DEFAULT_JSON_SIZE_LIMIT_BYTES);

    const contentLength = req.headers["content-length"];
    if (contentLength && parseInt(contentLength, 10) > limit) {
      res.statusCode = 413;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "Payload Too Large",
          message: `Request body exceeds size limit of ${limit} bytes`,
          statusCode: 413,
        })
      );
      return;
    }

    // Only inspect for JSON content types
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      next();
      return;
    }

    // If body is already parsed by prior middleware, inspect recursively
    if (req.body && typeof req.body === "object") {
      try {
        validateObjectPrototypes(req.body, options?.stripPrototypeKeys ?? false);
        next();
        return;
      } catch (err: any) {
        if (err instanceof PrototypePollutionError) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: "Bad Request",
              message: err.message,
              statusCode: 400,
            })
          );
          return;
        }
        next(err);
        return;
      }
    }

    // Otherwise read raw stream
    let body = "";
    let bytesRead = 0;
    let rejected = false;

    req.on("data", (chunk: Buffer | string) => {
      if (rejected) return;
      bytesRead += Buffer.byteLength(chunk);
      if (bytesRead > limit) {
        rejected = true;
        res.statusCode = 413;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: "Payload Too Large",
            message: `Request body exceeds size limit of ${limit} bytes`,
            statusCode: 413,
          })
        );
        req.removeAllListeners("data");
        req.removeAllListeners("end");
        return;
      }
      body += chunk;
    });

    req.on("end", () => {
      if (rejected) return;
      if (!body) {
        next();
        return;
      }
      try {
        req.body = parseSanitizedJson(body, { ...options, maxSizeBytes: limit });
        next();
      } catch (err: any) {
        if (err instanceof PrototypePollutionError) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: "Bad Request",
              message: err.message,
              statusCode: 400,
            })
          );
          return;
        }
        if (err instanceof PayloadTooLargeError) {
          res.statusCode = 413;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: "Payload Too Large",
              message: err.message,
              statusCode: 413,
            })
          );
          return;
        }
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: "Bad Request",
            message: "Malformed JSON payload",
            statusCode: 400,
          })
        );
      }
    });

    req.on("error", (err) => {
      if (!rejected) next(err);
    });
  };
}

function validateObjectPrototypes(obj: any, strip: boolean): void {
  if (!obj || typeof obj !== "object") return;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_PROTOTYPE_KEYS.has(key)) {
      if (strip) {
        delete obj[key];
      } else {
        throw new PrototypePollutionError(key);
      }
    } else {
      validateObjectPrototypes(obj[key], strip);
    }
  }
}

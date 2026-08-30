import type { IncomingMessage } from "node:http";
import { getBodyLimitConfig, parseJsonLimit } from "../routes/api-v1.js";

function getMaxBodySize(): number {
  return parseJsonLimit(getBodyLimitConfig().jsonLimit);
}

export class InvalidJsonError extends Error {
  constructor(message: string = "Invalid JSON body") {
    super(message);
    this.name = "InvalidJsonError";
  }
}

export class BodyTooLargeError extends Error {
  constructor(message: string = "Body too large") {
    super(message);
    this.name = "BodyTooLargeError";
  }
}

// Caches the parsed-body promise per request so callers that read the body
// more than once (e.g. openApiValidationMiddleware validating it, then the
// route handler reading it again) share a single stream read instead of the
// second caller hanging on an already-consumed IncomingMessage.
const parsedBodyCache = new WeakMap<IncomingMessage, Promise<any>>();

export async function readJsonBody(req: IncomingMessage): Promise<any> {
  const cached = parsedBodyCache.get(req);
  if (cached) return cached;

  const promise = new Promise<any>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      totalBytes += chunk.length;

      if (totalBytes > getMaxBodySize()) {
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
    });

    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new InvalidJsonError());
      }
    });

    req.on("error", (err) => {
      reject(err);
    });
  });

  parsedBodyCache.set(req, promise);
  return promise;
}

/**
 * Request/response logging middleware with PII masking
 * Issue #151
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { LogEntry, LoggingConfig } from "@delegolabs/types";
import { createLogger } from "@delegolabs/utils";
import { getRequestContext } from "../../middleware/requestId.js";
import { getAuthenticatedUserContext } from "../../middleware/auth.js";
import { maskPiiData, maskHeaders, isSensitiveEndpoint, shouldSample } from "./piiMasking.js";
import { storeLogEntry } from "./logStore.js";

const log = createLogger("gateway:http-logger", process.env.LOG_LEVEL ?? "info");

function getLoggingConfig(): LoggingConfig {
  return {
    enabled: process.env.HTTP_LOGGING_ENABLED !== "false",
    sampleRate: parseFloat(process.env.HTTP_LOGGING_SAMPLE_RATE ?? "1"),
    piiFields: (process.env.HTTP_LOGGING_PII_FIELDS ?? "").split(",").filter(Boolean),
    maskingRules: [],
    sensitiveEndpoints: (process.env.HTTP_LOGGING_SENSITIVE_ENDPOINTS ?? "/api/v1/auth").split(",").filter(Boolean),
    retentionDays: parseInt(process.env.HTTP_LOGGING_RETENTION_DAYS ?? "30", 10),
  };
}

function getHeaderValue(header: string | string[] | undefined): string {
  if (Array.isArray(header)) return header[0] ?? "";
  return header ?? "";
}

function captureHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return headers;
}

export function requestResponseLoggingMiddleware() {
  const config = getLoggingConfig();

  return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void => {
    if (!config.enabled) {
      next();
      return;
    }

    const path = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
    if (isSensitiveEndpoint(path, config.sensitiveEndpoints)) {
      next();
      return;
    }

    if (!shouldSample(config.sampleRate)) {
      next();
      return;
    }

    const startedAt = Date.now();
    const requestHeaders = captureHeaders(req);

    let requestBody: Record<string, unknown> = {};
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    const originalOn = req.on.bind(req);
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > 1024 * 100) {
        req.destroy();
      }
    };

    req.on("data", onData);

    const originalEnd = res.end.bind(res);
    const chunksWritten: Buffer[] = [];

    (res as any).end = function (this: ServerResponse, ...args: unknown[]) {
      const body = args[0];
      if (Buffer.isBuffer(body)) {
        chunksWritten.push(body);
      } else if (typeof body === "string") {
        chunksWritten.push(Buffer.from(body));
      }

      const durationMs = Date.now() - startedAt;
      const ctx = getRequestContext(req);
      const userCtx = getAuthenticatedUserContext(req);

      if (chunks.length > 0) {
        try {
          requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          requestBody = { _raw: true };
        }
      }

      let responseBody: Record<string, unknown> = {};
      if (chunksWritten.length > 0) {
        try {
          responseBody = JSON.parse(Buffer.concat(chunksWritten).toString("utf8"));
        } catch {
          responseBody = { _raw: true };
        }
      }

      const maskedRequest = maskPiiData(requestBody, config);
      const maskedResponse = maskPiiData(responseBody, config);
      const maskedReqHeaders = maskHeaders(requestHeaders, config);

      const entry: LogEntry = {
        requestId: ctx?.requestId ?? "unknown",
        timestamp: new Date().toISOString(),
        method: req.method ?? "UNKNOWN",
        path,
        requestHeaders: maskedReqHeaders.masked,
        requestBody: maskedRequest.masked,
        responseStatus: res.statusCode,
        responseHeaders: {},
        responseBody: maskedResponse.masked,
        durationMs,
        userId: userCtx?.userId,
        piiMasked: true,
      };

      storeLogEntry(entry);

      if (durationMs > 5000) {
        log.warn("Slow request detected", {
          path,
          method: req.method,
          durationMs,
          requestId: ctx?.requestId,
        });
      }

      originalEnd.apply(this, args as any);
    };

    req.on("end", () => {
      req.removeListener("data", onData);
    });

    next();
  };
}

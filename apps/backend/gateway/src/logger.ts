/**
 * Structured logging module using Pino
 * 
 * Provides:
 * - JSON-structured logging with NDJSON output
 * - Request ID correlation via middleware
 * - Child loggers with contextual metadata
 * - Configurable log levels via LOG_LEVEL environment variable
 * 
 * @module logger
 */

import pino from "pino";
import pinoHttp from "pino-http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

/**
 * Log levels supported by Pino
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Configure and create the root Pino logger instance
 */
function createRootLogger(): pino.Logger {
  const logLevel = (process.env.LOG_LEVEL || "info").toLowerCase() as LogLevel;
  
  // Determine if we're in development mode
  const isDevelopment = process.env.NODE_ENV === "development";
  
  return pino({
    level: logLevel,
    // Use ISO timestamps for better readability and compatibility
    timestamp: pino.stdTimeFunctions.isoTime,
    // Base metadata included in all logs
    base: {
      service: "gateway",
      env: process.env.NODE_ENV || "development",
      pid: process.pid,
    },
    // Pretty print in development for better readability
    transport: isDevelopment
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined,
    // Format error objects properly
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },
  });
}

/**
 * Root logger instance
 * Use this for application-level logging outside of request context
 */
export const logger = createRootLogger();

/**
 * Extract or generate request ID from incoming request
 * 
 * Checks for existing request ID in headers (supports common header names),
 * otherwise generates a new UUID v4.
 * 
 * @param req - Incoming HTTP request
 * @returns Request ID (existing or newly generated)
 */
function extractOrGenerateRequestId(req: IncomingMessage): string {
  // Check common request ID header names
  const headers = req.headers;
  const existingId =
    headers["x-request-id"] ||
    headers["x-correlation-id"] ||
    headers["x-trace-id"];
  
  if (existingId) {
    return Array.isArray(existingId) ? existingId[0] : existingId;
  }
  
  // Generate new UUID v4 for this request
  return randomUUID();
}

/**
 * Request logging middleware factory using pino-http
 * 
 * Features:
 * - Extracts or generates request ID
 * - Attaches request ID to response headers for client tracing
 * - Creates child logger with request context (reqId, method, path)
 * - Logs incoming requests and completed responses
 * - Includes response time and status code
 * 
 * @returns Express-compatible middleware function
 */
export function createRequestLoggingMiddleware() {
  return pinoHttp({
    logger,
    // Generate request ID and attach to logger context
    genReqId: extractOrGenerateRequestId,
    // Customize request ID property name in logs
    requestIdProperty: "reqId",
    // Custom logger instance per request with contextual data
    customLogLevel: (req, res, err) => {
      if (res.statusCode >= 500 || err) {
        return "error";
      }
      if (res.statusCode >= 400) {
        return "warn";
      }
      return "info";
    },
    // Custom request logging
    customReceivedMessage: (req) => {
      return `Incoming ${req.method} ${req.url}`;
    },
    // Custom response logging with duration
    customSuccessMessage: (req, res) => {
      return `Completed ${req.method} ${req.url} - ${res.statusCode}`;
    },
    // Custom error logging
    customErrorMessage: (req, res, err) => {
      return `Request ${req.method} ${req.url} failed - ${res.statusCode}: ${err.message}`;
    },
    // Customize request serialization
    serializers: {
      req: (req: IncomingMessage) => ({
        method: req.method,
        url: req.url,
        headers: {
          host: req.headers.host,
          "user-agent": req.headers["user-agent"],
          "content-type": req.headers["content-type"],
        },
        remoteAddress: req.socket?.remoteAddress,
      }),
      res: (res: ServerResponse) => ({
        statusCode: res.statusCode,
      }),
    },
    // Auto-log requests and responses
    autoLogging: {
      ignore: (req) => {
        // Don't auto-log health check endpoints
        const path = req.url || "";
        return (
          path === "/health" ||
          path === "/healthz" ||
          path === "/ready" ||
          path.startsWith("/health/")
        );
      },
    },
    // Customize additional request context
    customAttributeKeys: {
      req: "request",
      res: "response",
      err: "error",
      responseTime: "duration",
    },
  });
}

/**
 * Middleware wrapper that adds pino-http logging
 * and ensures x-request-id is set on response
 */
export function requestLoggingMiddleware() {
  const pinoMiddleware = createRequestLoggingMiddleware();
  
  return (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void): void => {
    // Apply pino-http middleware
    pinoMiddleware(req, res);
    
    // Extract request ID and set response header for client tracing
    const reqId = (req as any).id || extractOrGenerateRequestId(req);
    res.setHeader("x-request-id", reqId);
    
    // Continue to next middleware
    next();
  };
}

/**
 * Create a child logger with additional context
 * 
 * Useful for adding module-specific or operation-specific context
 * 
 * @param context - Additional context to include in all logs from this child logger
 * @returns Child logger instance
 * 
 * @example
 * const authLogger = createChildLogger({ module: 'auth' });
 * authLogger.info('User logged in', { userId: '123' });
 */
export function createChildLogger(context: Record<string, unknown>): pino.Logger {
  return logger.child(context);
}

/**
 * Log levels for manual level checking
 */
export const LOG_LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;

/**
 * Check if a given log level is enabled
 * 
 * @param level - Log level to check
 * @returns true if the level is enabled, false otherwise
 */
export function isLogLevelEnabled(level: LogLevel): boolean {
  return logger.isLevelEnabled(level);
}

/**
 * Flush any pending log writes (useful for graceful shutdown)
 */
export async function flushLogs(): Promise<void> {
  return new Promise((resolve) => {
    // Pino uses async logging, give it time to flush
    setTimeout(() => {
      resolve();
    }, 100);
  });
}

/**
 * Type augmentation for Express Request with logger
 * Allows TypeScript to recognize req.log property
 */
declare module "http" {
  interface IncomingMessage {
    log: pino.Logger;
    id: string;
  }
}

// Log initialization
logger.info("Logger initialized", {
  level: logger.level,
  env: process.env.NODE_ENV,
});

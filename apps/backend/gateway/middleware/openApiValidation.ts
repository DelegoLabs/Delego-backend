/**
 * OpenAPI request/response validation middleware (Issue #52).
 *
 * Validates inbound requests against the gateway's OpenAPI spec before they
 * reach route handlers, and optionally validates outbound responses against
 * the spec to catch service contract violations.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@delegolabs/utils";
import { badRequest } from "../src/errors.js";
import { readJsonBody, InvalidJsonError, BodyTooLargeError } from "../src/request.js";
import {
  OpenApiValidationEngine,
  DEFAULT_VALIDATION_CONFIG,
  type ValidationConfig,
} from "../src/openApiValidation.js";

const log = createLogger("gateway:openapi-validation");

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

function getRequestPathname(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  return url.pathname;
}

function isSkippedPath(pathname: string, skipPaths: string[]): boolean {
  return skipPaths.some((skip) => pathname === skip || pathname.startsWith(skip.endsWith("/") ? skip : `${skip}/`));
}

/**
 * Wraps res.write/res.end to buffer the outbound JSON body and validate it
 * against the operation's response schema once the handler finishes writing.
 * Validation failures are logged for monitoring — they never block or alter
 * the response already computed by the handler, so a spec/implementation
 * drift becomes visible in logs rather than turning an internal contract bug
 * into a customer-facing outage.
 */
function wrapForResponseValidation(
  res: ServerResponse,
  engine: OpenApiValidationEngine,
  operation: Record<string, any>,
  method: string,
  pathname: string
): void {
  let buffered = "";
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  (res as any).write = function patchedWrite(chunk: any, ...rest: any[]) {
    if (chunk) buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    return (originalWrite as any)(chunk, ...rest);
  };

  (res as any).end = function patchedEnd(chunk?: any, ...rest: any[]) {
    if (chunk) buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");

    try {
      const contentType = res.getHeader("Content-Type");
      if (buffered && typeof contentType === "string" && contentType.includes("application/json")) {
        const parsedBody = JSON.parse(buffered);
        const result = engine.validateResponse(operation, res.statusCode, parsedBody);
        if (!result.valid) {
          log.warn("Response failed OpenAPI validation — service contract violation", {
            method,
            path: pathname,
            status: res.statusCode,
            errors: result.errors,
          });
        }
      }
    } catch {
      // Non-JSON or unparsable body — nothing to validate against the spec.
    }

    return (originalEnd as any)(chunk, ...rest);
  };
}

/**
 * Creates the OpenAPI validation middleware.
 *
 * Loads the spec once at construction time (see OpenApiValidationEngine —
 * pass GATEWAY_OPENAPI_SPEC_PATH to enable hot-reload from an external JSON
 * file; without it, the built-in src/openapi.ts spec is used and changes
 * require a process restart, same as any other compiled module).
 */
export function openApiValidationMiddleware(userConfig: Partial<ValidationConfig> = {}) {
  const config: ValidationConfig = { ...DEFAULT_VALIDATION_CONFIG, ...userConfig };
  const engine = new OpenApiValidationEngine(config, process.env.GATEWAY_OPENAPI_SPEC_PATH);

  return async (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void): Promise<void> => {
    if (!config.enabled) {
      next();
      return;
    }

    const pathname = getRequestPathname(req);
    const method = (req.method ?? "GET").toUpperCase();

    if (isSkippedPath(pathname, config.skipPaths)) {
      next();
      return;
    }

    const resolved = engine.resolve(method, pathname);
    if (!resolved) {
      // No matching operation in the spec — this middleware only enforces
      // documented contracts; unmatched routes fall through to the router,
      // which returns its own 404 for truly unknown paths.
      next();
      return;
    }

    const { operation, pathParams } = resolved;

    try {
      if (config.validateRequests) {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        let body: unknown;
        let hasBody = false;

        if (METHODS_WITH_BODY.has(method) && operation.requestBody) {
          try {
            body = await readJsonBody(req);
            hasBody = true;
          } catch (err) {
            if (err instanceof InvalidJsonError) {
              badRequest(res, "Request body must be valid JSON", req, [
                { field: "body", message: "Invalid JSON", code: "type", path: ["body"] },
              ]);
              return;
            }
            if (err instanceof BodyTooLargeError) {
              // bodyLimitMiddleware runs earlier in the chain and normally
              // catches this first; re-throw so it still surfaces as an error.
              throw err;
            }
            throw err;
          }
        }

        const result = engine.validateRequest(operation, {
          method,
          pathParams,
          query: url.searchParams,
          headers: req.headers as Record<string, string | string[] | undefined>,
          body,
          hasBody,
        });

        if (!result.valid) {
          log.warn("Request failed OpenAPI validation", {
            method,
            path: pathname,
            errors: result.errors,
          });
          badRequest(res, "Request failed schema validation", req, result.errors);
          return;
        }

        if (result.sanitizedData) {
          (req as any).openApiValidated = result.sanitizedData;
        }
      }

      if (config.validateResponses) {
        wrapForResponseValidation(res, engine, operation, method, pathname);
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

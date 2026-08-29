/**
 * Reusable HTTP dependency health check helper (Issue #76).
 *
 * Probes an external/internal HTTP endpoint and reports:
 *   healthy   — 2xx/expected status within the timeout
 *   degraded  — non-2xx status (reachable but unhealthy)
 *   unhealthy — network error or timeout (throws)
 */

import type { CheckResult, HealthCheckFn } from "./types.js";

export interface HttpCheckOptions {
  url: string;
  method?: string;
  timeoutMs?: number;
  expectedStatus?: number;
  headers?: Record<string, string>;
  /** Extracts the dependency status from a 2xx JSON body. */
  bodyStatus?: (body: unknown) => CheckResult["status"];
  /** Injectable fetch implementation (used in tests). */
  fetchImpl?: typeof fetch;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function httpHealthCheck(options: HttpCheckOptions): HealthCheckFn {
  const {
    url,
    method = "GET",
    timeoutMs = 2000,
    expectedStatus,
    headers,
    bodyStatus,
    fetchImpl = fetch,
  } = options;

  return async (): Promise<CheckResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { Accept: "application/json", ...headers },
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(`HTTP check to ${url} failed: ${errorMessage(err)}`);
    } finally {
      clearTimeout(timer);
    }

    if (expectedStatus !== undefined && response.status !== expectedStatus) {
      return {
        status: "degraded",
        details: { url, httpStatus: response.status, expectedStatus },
      };
    }

    if (!response.ok) {
      return {
        status: "degraded",
        details: { url, httpStatus: response.status },
      };
    }

    if (bodyStatus) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      const status = bodyStatus(body);
      if (status) {
        return { status, details: { url, httpStatus: response.status } };
      }
    }

    return { status: "healthy", details: { url, httpStatus: response.status } };
  };
}

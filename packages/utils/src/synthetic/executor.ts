/**
 * Check Executor - Executes synthetic checks against endpoints
 */

import { createLogger } from "../logger.js";
import type {
  SyntheticCheck,
  CheckExecutionResult,
  Assertion,
  CheckType,
  AssertionOperator,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Check Executor
// ─────────────────────────────────────────────────────────────────────────────

export class CheckExecutor {
  private locations: string[];

  constructor(options: { locations: string[] }) {
    this.locations = options.locations;
  }

  // ─── Execute Check ──────────────────────────────────────────────────────

  async execute(check: SyntheticCheck, location: string): Promise<CheckExecutionResult> {
    const start = Date.now();

    try {
      const result = await this.executeCheckType(check, location);

      const executionTime = Date.now() - start;
      
      // Validate assertions
      const assertionResults = this.validateAssertions(check.assertions, result);

      // Determine overall status
      const allPassed = assertionResults.every((a) => a.passed);
      const status: "success" | "failed" | "degraded" = 
        allPassed ? "success" : "failed";

      return {
        checkId: check.id,
        location,
        timestamp: new Date().toISOString(),
        status,
        responseTime: executionTime,
        statusCode: result.statusCode,
        assertions: assertionResults,
        error: allPassed ? undefined : "Assertion failed",
        headers: result.headers,
        body: result.body,
        sslInfo: result.sslInfo,
        dnsInfo: result.dnsInfo,
      };
    } catch (error) {
      const executionTime = Date.now() - start;

      return {
        checkId: check.id,
        location,
        timestamp: new Date().toISOString(),
        status: "failed",
        responseTime: executionTime,
        statusCode: undefined,
        assertions: check.assertions.map((a) => ({
          passed: false,
          actual: "error",
          expected: a.value,
        })),
        error: (error as Error).message,
      };
    }
  }

  // ─── Execute by Check Type ──────────────────────────────────────────────

  private async executeCheckType(
    check: SyntheticCheck,
    location: string
  ): Promise<CheckExecutionResult> {
    switch (check.type) {
      case "http":
        return await this.executeHttpCheck(check);
      case "browser":
        return await this.executeBrowserCheck(check);
      case "dns":
        return await this.executeDnsCheck(check);
      case "tcp":
        return await this.executeTcpCheck(check);
      case "ssl":
        return await this.executeSslCheck(check);
      case "websocket":
        return await this.executeWebsocketCheck(check);
      default:
        throw new Error(`Unsupported check type: ${check.type}`);
    }
  }

  // ─── HTTP Check ─────────────────────────────────────────────────────────

  private async executeHttpCheck(check: SyntheticCheck): Promise<CheckExecutionResult> {
    const { url, method = "GET", headers = {}, body, auth } = check.request;

    const startTime = Date.now();

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ?? undefined,
        redirect: "follow",
        signal: AbortSignal.timeout(30000), // 30 second timeout
      });

      const executionTime = Date.now() - startTime;

      const text = await response.text();

      return {
        statusCode: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: text,
        responseTime: executionTime,
      };
    } catch (error) {
      throw new Error(`HTTP check failed: ${(error as Error).message}`);
    }
  }

  // ─── Browser Check ──────────────────────────────────────────────────────

  private async executeBrowserCheck(check: SyntheticCheck): Promise<CheckExecutionResult> {
    // Simulate browser check using Puppeteer-like approach
    const { url } = check.request;

    const startTime = Date.now();

    try {
      // In production, this would use a headless browser
      // For now, simulate with HTTP check
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(60000), // 60 second timeout for browser check
      });

      const executionTime = Date.now() - startTime;

      const text = await response.text();

      return {
        statusCode: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: text,
        responseTime: executionTime,
      };
    } catch (error) {
      throw new Error(`Browser check failed: ${(error as Error).message}`);
    }
  }

  // ─── DNS Check ──────────────────────────────────────────────────────────

  private async executeDnsCheck(check: SyntheticCheck): Promise<CheckExecutionResult> {
    const { url } = check.request;

    try {
      const dns = require("dns");
      
      const startTime = Date.now();
      
      // Extract hostname from URL
      const hostname = new URL(url).hostname;
      
      const addresses = await new Promise<string[]>((resolve, reject) => {
        dns.resolve4(hostname, (err, addresses) => {
          if (err) {
            // Try AAAA for IPv6
            dns.resolve6(hostname, (err2, addresses2) => {
              if (err2) {
                reject(err2);
              } else {
                resolve(addresses2 || []);
              }
            });
          } else {
            resolve(addresses || []);
          }
        });
      });

      const executionTime = Date.now() - startTime;

      return {
        statusCode: addresses.length > 0 ? 200 : 500,
        headers: { "X-DNS-Record-Type": "A" },
        dnsInfo: {
          ips: addresses,
          ttl: 300,
        },
        responseTime: executionTime,
      };
    } catch (error) {
      throw new Error(`DNS check failed: ${(error as Error).message}`);
    }
  }

  // ─── TCP Check ──────────────────────────────────────────────────────────

  private async executeTcpCheck(check: SyntheticCheck): Promise<CheckExecutionResult> {
    const { url } = check.request;

    try {
      const net = require("net");
      
      const parsedUrl = new URL(url);
      const host = parsedUrl.hostname;
      const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 80;

      const startTime = Date.now();

      await new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        
        socket.on("connect", () => {
          socket.destroy();
          resolve(null);
        });

        socket.on("error", (err) => {
          reject(err);
        });

        socket.setTimeout(10000);
      });

      const executionTime = Date.now() - startTime;

      return {
        statusCode: 200,
        responseTime: executionTime,
      };
    } catch (error) {
      throw new Error(`TCP check failed: ${(error as Error).message}`);
    }
  }

  // ─── SSL Check ──────────────────────────────────────────────────────────

  private async executeSslCheck(check: SyntheticCheck): Promise<CheckExecutionResult> {
    const { url } = check.request;

    try {
      const https = require("https");
      
      const startTime = Date.now();

      await new Promise((resolve, reject) => {
        const req = https.request(url, { method: "HEAD" }, (res) => {
          res.resume(); // Consume response data
          resolve(null);
        });

        req.on("error", (err) => {
          reject(err);
        });

        req.on("socket", (socket) => {
          socket.on("secureConnect", () => {
            // SSL handshake completed
          });
        });

        req.end();
      });

      const executionTime = Date.now() - startTime;

      return {
        statusCode: 200,
        responseTime: executionTime,
        sslInfo: {
          valid: true,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // Mock
          issuer: "Let's Encrypt",
        },
      };
    } catch (error) {
      throw new Error(`SSL check failed: ${(error as Error).message}`);
    }
  }

  // ─── WebSocket Check ────────────────────────────────────────────────────

  private async executeWebsocketCheck(check: SyntheticCheck): Promise<CheckExecutionResult> {
    const { url } = check.request;

    try {
      const ws = require("ws");

      const startTime = Date.now();

      await new Promise((resolve, reject) => {
        const socket = new ws(url);

        socket.on("open", () => {
          socket.close();
          resolve(null);
        });

        socket.on("error", (err) => {
          reject(err);
        });

        setTimeout(() => {
          reject(new Error("WebSocket connection timeout"));
        }, 10000);
      });

      const executionTime = Date.now() - startTime;

      return {
        statusCode: 101, // WebSocket switch protocol
        responseTime: executionTime,
      };
    } catch (error) {
      throw new Error(`WebSocket check failed: ${(error as Error).message}`);
    }
  }

  // ─── Assertion Validation ───────────────────────────────────────────────

  private validateAssertions(
    assertions: Assertion[],
    result: CheckExecutionResult
  ): Array<{ passed: boolean; actual: string; expected: string }> {
    return assertions.map((assertion) => {
      const actual = this.getAssertionValue(assertion, result);
      const expected = assertion.value;
      const passed = this.evaluateAssertion(assertion, actual, expected);

      return {
        passed,
        actual,
        expected,
      };
    });
  }

  private getAssertionValue(assertion: Assertion, result: CheckExecutionResult): string {
    switch (assertion.type) {
      case "status_code":
        return String(result.statusCode ?? 0);
      case "response_time":
        return String(result.responseTime);
      case "body_contains":
        return result.body ?? "";
      case "json_path":
        try {
          const json = JSON.parse(result.body || "{}");
          // Simple JSON path parsing
          const parts = assertion.value.split(".");
          let value: unknown = json;
          for (const part of parts) {
            value = (value as Record<string, unknown>)[part];
          }
          return String(value ?? "");
        } catch {
          return "";
        }
      case "header":
        return result.headers?.[assertion.value.toLowerCase()] ?? "";
      case "certificate":
        return result.sslInfo?.valid ? "valid" : "invalid";
      default:
        return "";
    }
  }

  private evaluateAssertion(
    assertion: Assertion,
    actual: string,
    expected: string
  ): boolean {
    const actualNum = parseFloat(actual);
    const expectedNum = parseFloat(expected);

    switch (assertion.operator) {
      case "eq":
        return actual === expected;
      case "neq":
        return actual !== expected;
      case "gt":
        return !isNaN(actualNum) && !isNaN(expectedNum) && actualNum > expectedNum;
      case "lt":
        return !isNaN(actualNum) && !isNaN(expectedNum) && actualNum < expectedNum;
      case "contains":
        return actual.includes(expected);
      case "matches":
        try {
          const regex = new RegExp(expected);
          return regex.test(actual);
        } catch {
          return false;
        }
      default:
        return false;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger("utils:synthetic-executor", process.env.LOG_LEVEL ?? "info");
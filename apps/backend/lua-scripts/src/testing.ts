/**
 * Lua script testing framework
 * Issue #156
 */

import { createLogger } from "@delegolabs/utils";
import type { LuaScript, ScriptTestResult, ScriptTestSuite } from "@delegolabs/types";

const log = createLogger("lua-scripts:test", process.env.LOG_LEVEL ?? "info");

interface MockRedis {
  data: Map<string, unknown>;
  evalsha(sha: string, keys: string[], args: unknown[]): unknown;
  set(key: string, value: unknown): void;
  get(key: string): unknown;
  del(key: string): void;
  exists(key: string): boolean;
}

function createMockRedis(): MockRedis {
  const data = new Map<string, unknown>();

  return {
    data,
    evalsha(_sha: string, keys: string[], args: unknown[]): unknown {
      return { keys, args, mock: true };
    },
    set(key: string, value: unknown) {
      data.set(key, value);
    },
    get(key: string) {
      return data.get(key) ?? null;
    },
    del(key: string) {
      data.delete(key);
    },
    exists(key: string) {
      return data.has(key);
    },
  };
}

export function runTest(script: LuaScript, testCase: { name: string; keys: string[]; args: unknown[]; expected: unknown }): ScriptTestResult {
  const start = performance.now();

  try {
    const redis = createMockRedis();
    const result = redis.evalsha(script.sha, testCase.keys, testCase.args);

    const durationMs = performance.now() - start;
    const passed = JSON.stringify(result) === JSON.stringify(testCase.expected);

    if (!passed) {
      log.warn("Test failed", {
        script: script.name,
        test: testCase.name,
        expected: testCase.expected,
        actual: result,
      });
    }

    return {
      passed,
      testName: testCase.name,
      expected: testCase.expected,
      actual: result,
      durationMs,
    };
  } catch (err) {
    const durationMs = performance.now() - start;
    return {
      passed: false,
      testName: testCase.name,
      expected: testCase.expected,
      actual: null,
      error: err instanceof Error ? err.message : String(err),
      durationMs,
    };
  }
}

export function runTestSuite(script: LuaScript): ScriptTestSuite {
  const start = performance.now();
  const results = script.testCases.map((tc) => runTest(script, tc));
  const durationMs = performance.now() - start;

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  log.info("Test suite completed", {
    script: script.name,
    version: script.version,
    passed,
    failed,
    total: results.length,
    durationMs,
  });

  return {
    scriptName: script.name,
    version: script.version,
    results,
    passed,
    failed,
    total: results.length,
    durationMs,
  };
}

export function validateScriptSyntax(source: string): { valid: boolean; error?: string } {
  if (!source || source.trim().length === 0) {
    return { valid: false, error: "Script source is empty" };
  }

  const openBraces = (source.match(/{/g) ?? []).length;
  const closeBraces = (source.match(/}/g) ?? []).length;
  if (openBraces !== closeBraces) {
    return { valid: false, error: `Mismatched braces: ${openBraces} open, ${closeBraces} close` };
  }

  const openParens = (source.match(/\(/g) ?? []).length;
  const closeParens = (source.match(/\)/g) ?? []).length;
  if (openParens !== closeParens) {
    return { valid: false, error: `Mismatched parentheses: ${openParens} open, ${closeParens} close` };
  }

  if (source.includes("redis.call") || source.includes("redis.pcall")) {
    const returnCount = (source.match(/return\s/g) ?? []).length;
    if (returnCount === 0) {
      return { valid: false, error: "Script has redis calls but no return statement" };
    }
  }

  return { valid: true };
}

export function generateTestReport(suite: ScriptTestSuite): string {
  const lines: string[] = [
    `Test Report: ${suite.scriptName} v${suite.version}`,
    `Duration: ${suite.durationMs.toFixed(2)}ms`,
    `Results: ${suite.passed}/${suite.total} passed`,
    "",
  ];

  for (const result of suite.results) {
    const status = result.passed ? "PASS" : "FAIL";
    lines.push(`  [${status}] ${result.testName} (${result.durationMs.toFixed(2)}ms)`);
    if (!result.passed) {
      if (result.error) {
        lines.push(`    Error: ${result.error}`);
      } else {
        lines.push(`    Expected: ${JSON.stringify(result.expected)}`);
        lines.push(`    Actual:   ${JSON.stringify(result.actual)}`);
      }
    }
  }

  return lines.join("\n");
}

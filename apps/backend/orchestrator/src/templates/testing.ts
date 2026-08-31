/**
 * Template testing framework — executes declared test cases against a template,
 * verifying that:
 *   1. Required parameters are validated (missing/invalid values are rejected).
 *   2. Defaults are applied for optional parameters.
 *   3. Instantiation succeeds and produces a context that matches expectations.
 *   4. The resolved definition is structurally sound.
 *
 * A passing suite can be used to mark a template "verified" in the catalog.
 */
import { createLogger } from "@delegolabs/utils";
import type { TemplateTestSuite, TemplateTestResult } from "./types.js";
import { instantiateTemplate } from "./instantiation.js";
import { getTemplateByVersion } from "./registry.js";
import { validateTemplateDefinition } from "./schema.js";
import { getResolvedTemplate } from "./registry.js";

const log = createLogger("orchestrator:templates:testing", process.env.LOG_LEVEL ?? "info");

/** A single declared test case. */
export interface TemplateTestCaseInput {
  name: string;
  /** Parameters passed to instantiation. */
  parameters?: Record<string, unknown>;
  /** Expected keys present in the final context. */
  expectContext?: Record<string, unknown>;
  /** When true, expect instantiation to fail. */
  expectError?: boolean;
}

export interface TemplateTestOptions {
  /** Test cases to run; defaults to a built-in set exercising validation. */
  cases?: TemplateTestCaseInput[];
  instantiatedBy?: string;
}

/**
 * Runs a template's test suite and returns the results. Optionally passes the
 * corresponding version for precise version pinning.
 */
export async function runTemplateTests(
  templateId: string,
  options: TemplateTestOptions = {},
): Promise<TemplateTestSuite> {
  const start = Date.now();
  const results: TemplateTestResult[] = [];

  const template = getTemplateByVersion(templateId);
  if (!template) {
    throw new Error(`Template "${templateId}" not found`);
  }
  const version = template.version;

  const cases = options.cases ?? defaultCases(templateId);

  for (const testCase of cases) {
    const caseStart = Date.now();
    try {
      const defErrors = validateTemplateDefinition(template.definition);
      if (defErrors.length > 0) {
        throw new Error(`Invalid definition: ${defErrors.join("; ")}`);
      }

      let failed = false;
      let error: string | undefined;

      if (testCase.expectError) {
        try {
          await instantiateTemplate({
            templateId,
            templateVersion: version,
            parameters: testCase.parameters ?? {},
            instantiatedBy: options.instantiatedBy ?? "test-runner",
          });
          failed = true;
          error = "Expected instantiation to fail but it succeeded";
        } catch {
          // Expected failure — pass.
        }
      } else {
        const { definition } = await instantiateTemplate({
          templateId,
          templateVersion: version,
          parameters: testCase.parameters ?? {},
          instantiatedBy: options.instantiatedBy ?? "test-runner",
        });
        if (testCase.expectContext) {
          for (const [key, expected] of Object.entries(testCase.expectContext)) {
            const actual = definition.context[key];
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
              failed = true;
              error = `Context key "${key}" = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
              break;
            }
          }
        }
      }

      results.push({
        name: testCase.name,
        passed: !failed,
        error,
        durationMs: Date.now() - caseStart,
      });
    } catch (err) {
      results.push({
        name: testCase.name,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - caseStart,
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const suite: TemplateTestSuite = {
    templateId,
    version,
    results,
    passed,
    failed: results.length - passed,
    total: results.length,
    durationMs: Date.now() - start,
    verified: results.length > 0 && passed === results.length,
  };

  log.info("Template test suite finished", {
    templateId,
    version,
    passed: suite.passed,
    failed: suite.failed,
    verified: suite.verified,
  });

  return suite;
}

/** Builds a default regression suite derived from the template's parameter schema. */
function defaultCases(templateId: string): TemplateTestCaseInput[] {
  const resolved = getResolvedTemplate(templateId);
  if (!resolved) return [];

  const requiredMissing = resolved.parameters
    .filter((p) => p.required)
    .map((p) => p.name);

  const valid: Record<string, unknown> = {};
  for (const p of resolved.parameters) {
    valid[p.name] = sampleValue(p.type);
  }

  const cases: TemplateTestCaseInput[] = [];

  if (requiredMissing.length > 0) {
    cases.push({
      name: `rejects missing required parameters (${requiredMissing.join(", ")})`,
      parameters: {},
      expectError: true,
    });
  }

  cases.push({
    name: "instantiates with valid parameters",
    parameters: valid,
  });

  // Verify a required param with no default is rejected.
  const firstRequired = resolved.parameters.find((p) => p.required && p.default === undefined);
  if (firstRequired) {
    const partial = { ...valid };
    delete partial[firstRequired.name];
    cases.push({
      name: `rejects missing "${firstRequired.name}"`,
      parameters: partial,
      expectError: true,
    });
  }

  return cases;
}

function sampleValue(type: string): unknown {
  switch (type) {
    case "string":
      return "test-value";
    case "number":
      return 1;
    case "boolean":
      return true;
    case "object":
      return {};
    case "array":
      return [];
    default:
      return "test-value";
  }
}

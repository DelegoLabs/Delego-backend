/**
 * Unit tests for the template testing framework and documentation generator.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { WorkflowTemplate } from "@delegolabs/types";
import { resetTemplateRegistry, registerTemplate } from "./registry.js";
import { runTemplateTests } from "./testing.js";
import { generateTemplateDocumentation, renderTemplateDocumentation } from "./documentation.js";

function base(overrides: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  const now = new Date().toISOString();
  return {
    id: "tpl-1",
    name: "Checkout",
    description: "A checkout flow",
    version: "1.0.0",
    category: "commerce",
    tags: ["checkout", "payments"],
    definition: {
      states: { Discovery: { description: "starting" }, Completed: { description: "done" } },
      transitions: [{ from: "Discovery", on: "GO", to: "Completed" }],
      context: { region: "global" },
    },
    parameters: [
      { name: "merchantId", type: "string", required: true, description: "The merchant" },
      { name: "timeoutSec", type: "number", required: false, default: 30, description: "Timeout" },
    ],
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    ...overrides,
  };
}

describe("runTemplateTests", () => {
  beforeEach(() => resetTemplateRegistry());

  it("runs the built-in suite and marks verified when everything passes", async () => {
    registerTemplate(base());
    const suite = await runTemplateTests("tpl-1");
    expect(suite.verified).toBe(true);
    expect(suite.failed).toBe(0);
    expect(suite.passed).toBeGreaterThanOrEqual(2);
    expect(suite.total).toBe(suite.results.length);
  });

  it("fails the suite when a required parameter has no satisfying value", async () => {
    // A number with min/max that excludes the sample value 1 -> rejection.
    registerTemplate(
      base({
        parameters: [
          { name: "qty", type: "number", required: true, validation: JSON.stringify({ minimum: 10 }), description: "" },
        ],
      }),
    );
    const suite = await runTemplateTests("tpl-1");
    expect(suite.verified).toBe(false);
    expect(suite.failed).toBeGreaterThan(0);
  });

  it("supports custom test cases with expectation helpers", async () => {
    registerTemplate(base());
    const suite = await runTemplateTests("tpl-1", {
      cases: [
        { name: "custom happy path", parameters: { merchantId: "m1" }, expectError: false },
        { name: "custom presence check", parameters: { merchantId: "m2" }, expectContext: { merchantId: "m2" } },
      ],
    });
    expect(suite.verified).toBe(true);
    expect(suite.passed).toBe(2);
  });

  it("detects an expectation mismatch", async () => {
    registerTemplate(base());
    const suite = await runTemplateTests("tpl-1", {
      cases: [
        { name: "wrong context", parameters: { merchantId: "m1" }, expectContext: { merchantId: "OTHER" } },
      ],
    });
    expect(suite.verified).toBe(false);
    expect(suite.results[0].passed).toBe(false);
  });

  it("throws for a missing template", async () => {
    await expect(runTemplateTests("ghost")).rejects.toThrow(/not found/);
  });
});

describe("generateTemplateDocumentation", () => {
  beforeEach(() => resetTemplateRegistry());

  it("generates sections covering overview, parameters, states, and transitions", () => {
    registerTemplate(base());
    const doc = generateTemplateDocumentation("tpl-1");
    expect(doc.name).toBe("Checkout");
    expect(doc.version).toBe("1.0.0");

    const titles = doc.sections.map((s) => s.title);
    expect(titles).toEqual(
      expect.arrayContaining(["Overview", "Parameters", "States", "Transitions", "Instantiation Example"]),
    );

    expect(doc.markdown).toContain("# Checkout");
    expect(doc.markdown).toContain("merchantId");
    expect(doc.markdown).toContain("Discovery");
    expect(doc.markdown).toContain("Instantiation Example");
  });

  it("renderTemplateDocumentation returns the raw markdown string", () => {
    registerTemplate(base());
    const md = renderTemplateDocumentation("tpl-1");
    expect(typeof md).toBe("string");
    expect(md).toContain("## Parameters");
  });

  it("throws when the template does not exist", () => {
    expect(() => generateTemplateDocumentation("ghost")).toThrow(/not found/);
  });
});

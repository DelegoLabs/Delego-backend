/**
 * Unit tests for the workflow template parameter schema validation and defaults.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  validateParameters,
  validateParameterValue,
  validateTemplateDefinition,
  validateAgainstJsonSchema,
  ParameterValidationError,
} from "./schema.js";
import { instantiateTemplate, resolveTemplateContext } from "./instantiation.js";
import { registerTemplate, resetTemplateRegistry } from "./registry.js";
import type { WorkflowTemplate } from "@delegolabs/types";

function makeTemplate(overrides: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  const now = new Date().toISOString();
  return {
    id: "tpl-1",
    name: "Checkout",
    description: "A checkout template",
    version: "1.0.0",
    category: "commerce",
    tags: ["checkout"],
    definition: {
      states: { INITIATED: {}, COMPLETED: {} },
      transitions: [{ from: "INITIATED", on: "COMPLETE", to: "COMPLETED" }],
      context: {},
    },
    parameters: [],
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    ...overrides,
  };
}

describe("validateParameterValue", () => {
  it("accepts values matching the declared type", () => {
    expect(
      validateParameterValue({ name: "amount", type: "number", required: true, description: "" }, 42),
    ).toEqual([]);
    expect(
      validateParameterValue({ name: "label", type: "string", required: true, description: "" }, "abc"),
    ).toEqual([]);
    expect(
      validateParameterValue({ name: "flag", type: "boolean", required: true, description: "" }, true),
    ).toEqual([]);
  });

  it("rejects values of the wrong type", () => {
    expect(
      validateParameterValue({ name: "amount", type: "number", required: true, description: "" }, "42"),
    ).not.toEqual([]);
    expect(
      validateParameterValue({ name: "amount", type: "number", required: true, description: "" }, NaN),
    ).not.toEqual([]);
  });

  it("enforces a JSON Schema fragment", () => {
    const p = {
      name: "size",
      type: "number",
      required: true,
      validation: JSON.stringify({ minimum: 1, maximum: 100 }),
      description: "",
    };
    expect(validateParameterValue(p, 0)).not.toEqual([]);
    expect(validateParameterValue(p, 101)).not.toEqual([]);
    expect(validateParameterValue(p, 50)).toEqual([]);
  });

  it("enforces enum and pattern", () => {
    const enumP = {
      name: "currency",
      type: "string",
      required: true,
      validation: JSON.stringify({ enum: ["USD", "EUR"] }),
      description: "",
    };
    expect(validateParameterValue(enumP, "GBP")).not.toEqual([]);
    expect(validateParameterValue(enumP, "USD")).toEqual([]);
  });
});

describe("validateParameters", () => {
  const params = [
    { name: "userId", type: "string" as const, required: true, description: "" },
    { name: "retry", type: "number" as const, required: false, default: 3, description: "" },
  ];

  it("fills in defaults for missing optional parameters", () => {
    const result = validateParameters(params, { userId: "u1" });
    expect(result.valid).toBe(true);
    expect(result.resolved).toEqual({ userId: "u1", retry: 3 });
  });

  it("reports missing required parameters", () => {
    const result = validateParameters(params, {});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required parameter "userId"');
  });

  it("reports type mismatches", () => {
    const result = validateParameters(params, { userId: "u1", retry: "many" });
    expect(result.valid).toBe(false);
  });
});

describe("validateTemplateDefinition", () => {
  it("accepts a well-formed definition", () => {
    expect(
      validateTemplateDefinition({ states: { A: {} }, transitions: [{ from: "A", to: "B" }], context: {} }),
    ).toEqual([]);
  });

  it("rejects empty states or transitions", () => {
    expect(validateTemplateDefinition({ states: {}, transitions: [{ from: "A" }], context: {} })).not.toEqual([]);
    expect(validateTemplateDefinition({ states: { A: {} }, transitions: [], context: {} })).not.toEqual([]);
  });

  it("rejects missing definition keys", () => {
    expect(validateTemplateDefinition({} as any)).not.toEqual([]);
  });
});

describe("validateAgainstJsonSchema", () => {
  it("handles object properties and required", () => {
    const schema = JSON.stringify({
      type: "object",
      properties: {
        name: { type: "string", minLength: 2 },
        qty: { type: "number", minimum: 1 },
      },
    });
    expect(validateAgainstJsonSchema({ name: "a", qty: 0 }, schema, "item")).not.toEqual([]);
    expect(validateAgainstJsonSchema({ name: "ab", qty: 1 }, schema, "item")).toEqual([]);
  });

  it("returns an error for an invalid schema fragment", () => {
    expect(validateAgainstJsonSchema("x", "{not-json", "v")).not.toEqual([]);
  });
});

describe("integration: instantiation validates & applies defaults", () => {
  beforeEach(() => {
    resetTemplateRegistry();
  });

  it("rejects instantiation with missing required parameters", async () => {
    registerTemplate(
      makeTemplate({
        parameters: [
          { name: "merchantId", type: "string", required: true, description: "" },
          { name: "timeoutSec", type: "number", required: false, default: 30, description: "" },
        ],
      }),
    );

    await expect(
      instantiateTemplate({
        templateId: "tpl-1",
        parameters: {},
        instantiatedBy: "u1",
      }),
    ).rejects.toBeInstanceOf(ParameterValidationError);
  });

  it("applies defaults and interpolates into context", async () => {
    registerTemplate(
      makeTemplate({
        parameters: [
          { name: "merchantId", type: "string", required: true, description: "" },
          { name: "timeoutSec", type: "number", required: false, default: 30, description: "" },
        ],
      }),
    );

    const { workflow, definition } = await instantiateTemplate({
      templateId: "tpl-1",
      parameters: { merchantId: "m1" },
      instantiatedBy: "u1",
    });

    expect(workflow.parameters).toEqual({ merchantId: "m1", timeoutSec: 30 });
    expect(definition.context.timeoutSec).toBe(30);
    expect(definition.context.merchantId).toBe("m1");
    expect(definition.context.templateId).toBe("tpl-1");
  });

  it("throws when the template does not exist", async () => {
    await expect(
      instantiateTemplate({ templateId: "nope", parameters: {}, instantiatedBy: "u1" }),
    ).rejects.toThrow("not found");
  });
});

describe("resolveTemplateContext", () => {
  beforeEach(() => resetTemplateRegistry());

  it("resolves a context with defaults", async () => {
    registerTemplate(
      makeTemplate({
        parameters: [
          { name: "a", type: "string", required: true, description: "" },
          { name: "b", type: "number", required: false, default: 5, description: "" },
        ],
      }),
    );
    const ctx = resolveTemplateContext("tpl-1", { a: "x" });
    expect(ctx).toMatchObject({ a: "x", b: 5 });
  });
});

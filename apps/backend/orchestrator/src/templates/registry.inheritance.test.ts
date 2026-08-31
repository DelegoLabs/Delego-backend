/**
 * Unit tests for the workflow template registry: versioning, catalog, ratings,
 * downloads, and inheritance.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { WorkflowTemplate } from "@delegolabs/types";
import {
  resetTemplateRegistry,
  registerTemplate,
  getTemplateByVersion,
  listTemplates,
  listTemplateVersions,
  deleteTemplate,
  deprecateTemplateVersion,
  recordDownload,
  rateTemplate,
  markTemplateVerified,
  buildCatalog,
  getResolvedTemplate,
} from "./registry.js";
import { getAncestry, TemplateInheritanceError } from "./inheritance.js";

function base(overrides: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  const now = new Date().toISOString();
  return {
    id: "tpl-1",
    name: "Checkout",
    description: "desc",
    version: "1.0.0",
    category: "commerce",
    tags: ["checkout"],
    definition: { states: { A: {} }, transitions: [{ from: "A", to: "B" }], context: {} },
    parameters: [],
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    ...overrides,
  };
}

function version(id: string, version: string): WorkflowTemplate {
  return base({ id, version, name: `${id} v${version}` });
}

describe("registerTemplate", () => {
  beforeEach(() => resetTemplateRegistry());

  it("registers a new template as current", () => {
    registerTemplate(base());
    expect(getTemplateByVersion("tpl-1")?.version).toBe("1.0.0");
    expect(listTemplates()).toHaveLength(1);
  });

  it("versions a re-registration and deprecates the previous active version", () => {
    registerTemplate(base());
    registerTemplate(base({ version: "2.0.0" }));

    const versions = listTemplateVersions("tpl-1");
    expect(versions).toHaveLength(2);
    expect(getTemplateByVersion("tpl-1")?.version).toBe("2.0.0");
    expect(getTemplateByVersion("tpl-1", "1.0.0")?.version).toBe("1.0.0");
    const registry = buildCatalog().templates.find((t) => t.id === "tpl-1")!;
    expect(registry.version).toBe("2.0.0");
  });

  it("rejects duplicate versions", () => {
    registerTemplate(base());
    expect(() => registerTemplate(base())).toThrow(/already has version/);
  });

  it("rejects an invalid definition", () => {
    expect(() => registerTemplate(base({ definition: { states: {}, transitions: [], context: {} } }))).toThrow(
      /Invalid template definition/,
    );
  });
});

describe("deleteTemplate / deprecateTemplateVersion", () => {
  beforeEach(() => resetTemplateRegistry());

  it("deletes a template", () => {
    registerTemplate(base());
    expect(deleteTemplate("tpl-1")).toBe(true);
    expect(getTemplateByVersion("tpl-1")).toBeNull();
    expect(deleteTemplate("tpl-1")).toBe(false);
  });

  it("deprecates a version and rolls current forward", () => {
    registerTemplate(base({ version: "1.0.0" }));
    registerTemplate(base({ version: "2.0.0" }));
    expect(deprecateTemplateVersion("tpl-1", "1.0.0")).toBe(true);
    // Deprecating a non-current version keeps current as-is.
    expect(getTemplateByVersion("tpl-1")?.version).toBe("2.0.0");
  });
});

describe("catalog, ratings, downloads", () => {
  beforeEach(() => resetTemplateRegistry());

  it("builds a catalog with ratings, downloads, and categories", () => {
    registerTemplate(base());
    recordDownload("tpl-1");
    recordDownload("tpl-1");
    rateTemplate("tpl-1", { rating: 5, ratedBy: "u1" });
    markTemplateVerified("tpl-1", true);

    const catalog = buildCatalog();
    expect(catalog.categories).toEqual(["commerce"]);
    const entry = catalog.templates[0];
    expect(entry.downloads).toBe(2);
    expect(entry.rating).toBe(5);
    expect(entry.verified).toBe(true);
  });

  it("rejects ratings outside 1-5", () => {
    registerTemplate(base());
    expect(() => rateTemplate("tpl-1", { rating: 99, ratedBy: "u1" })).toThrow(/between 1 and 5/);
  });

  it("sorts catalog by downloads then rating", () => {
    registerTemplate(base({ id: "tpl-low", name: "low" }));
    registerTemplate(base({ id: "tpl-high", name: "high" }));
    recordDownload("tpl-high");
    const catalog = buildCatalog();
    expect(catalog.templates[0].id).toBe("tpl-high");
  });
});

describe("inheritance", () => {
  beforeEach(() => resetTemplateRegistry());

  it("resolves inherited definitions and parameters without duplication", () => {
    registerTemplate(
      base({
        id: "base",
        version: "1.0.0",
        parameters: [{ name: "shared", type: "string", required: true, description: "" }],
        definition: {
          states: { Discovery: { kind: "initial" } },
          transitions: [{ from: "Discovery", on: "GO", to: "Checkout" }],
          context: { region: "global" },
        },
      }),
    );

    registerTemplate(
      base({
        id: "checkout",
        version: "1.0.0",
        parentTemplateId: "base",
        parameters: [
          { name: "merchantId", type: "string", required: true, description: "" },
          // Overrides inherited "shared" optionality
          { name: "shared", type: "string", required: true, description: "override" },
        ],
        definition: {
          states: { Checkout: { kind: "main" } },
          transitions: [{ from: "Checkout", on: "DONE", to: "Completed" }],
          context: { channel: "web" },
        },
      }),
    );

    const resolved = getResolvedTemplate("checkout")!;
    expect(resolved.definition.states).toHaveProperty("Discovery");
    expect(resolved.definition.states).toHaveProperty("Checkout");
    expect(resolved.definition.transitions).toHaveLength(2);
    expect(resolved.definition.context).toMatchObject({ region: "global", channel: "web" });
    expect(resolved.parameters.map((p) => p.name)).toEqual(["shared", "merchantId"]);
    expect(resolved.parameters.find((p) => p.name === "shared")?.description).toBe("override");
    expect(resolved.tags).toContain("checkout");

    // Ancestry root-first
    expect(getAncestry("checkout", (id) => getTemplateByVersion(id)).map((a) => a.id)).toEqual([
      "base",
      "checkout",
    ]);
  });

  it("throws on a missing parent", () => {
    // Simulate an orphaned template (e.g. parent deleted after registration) by
    // supplying a lookup that returns null for the missing parent.
    const getById = (id: string) =>
      id === "child" ? base({ id: "child", parentTemplateId: "ghost" }) : null;
    expect(() => getAncestry("child", getById)).toThrow(TemplateInheritanceError);
  });

  it("throws on circular inheritance", () => {
    const store: Record<string, WorkflowTemplate> = {
      a: base({ id: "a", parentTemplateId: "b" }),
      b: base({ id: "b", parentTemplateId: "a" }),
    };
    expect(() => getAncestry("a", (id) => store[id] ?? null)).toThrow(/Circular/);
  });
});

describe("instantiation respects inheritance parameters", () => {
  beforeEach(() => resetTemplateRegistry());

  it("validates combined inherited + child parameters", async () => {
    const { instantiateTemplate } = await import("./instantiation.js");
    registerTemplate(
      base({ id: "base", parameters: [{ name: "shared", type: "string", required: true, description: "" }] }),
    );
    registerTemplate(
      base({
        id: "child",
        parentTemplateId: "base",
        parameters: [{ name: "own", type: "number", required: true, description: "" }],
      }),
    );

    await expect(
      instantiateTemplate({ templateId: "child", parameters: {}, instantiatedBy: "u" }),
    ).rejects.toThrow(/Missing required/);

    const { workflow, definition } = await instantiateTemplate({
      templateId: "child",
      parameters: { shared: "x", own: 1 },
      instantiatedBy: "u",
    });
    expect(definition.context).toMatchObject({ shared: "x", own: 1 });
    expect(workflow.templateVersion).toBe("1.0.0");
  });
});

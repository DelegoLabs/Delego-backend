import { describe, it, expect } from "vitest";
import {
  validateTerraformModule,
  findCircularDependency,
  validateModuleTest,
} from "./terraformModuleValidation.js";
import type { ModuleTest, TerraformModule } from "./terraformModule.js";

function buildModule(overrides: Partial<TerraformModule> = {}): TerraformModule {
  return {
    name: "vpc",
    version: "1.0.0",
    source: "git::https://github.com/delegolabs/terraform-modules//vpc",
    inputs: [{ name: "cidr_block", type: "string", description: "VPC CIDR", required: true }],
    outputs: [{ name: "vpc_id", description: "VPC ID", sensitive: false }],
    dependencies: [],
    documentation: "# VPC Module\n...",
    ...overrides,
  };
}

describe("validateTerraformModule", () => {
  it("passes a well-formed module", () => {
    const result = validateTerraformModule(buildModule());
    expect(result.valid).toBe(true);
  });

  it("fails a non-semver version", () => {
    const result = validateTerraformModule(buildModule({ version: "v1" }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/non-semver/);
  });

  it("fails a module with no documentation", () => {
    const result = validateTerraformModule(buildModule({ documentation: "" }));
    expect(result.valid).toBe(false);
  });

  it("fails a required input that also declares a default value", () => {
    const module = buildModule({
      inputs: [{ name: "x", type: "string", description: "x", required: true, default: "foo" }],
    });
    expect(validateTerraformModule(module).valid).toBe(false);
  });

  it("fails duplicate input names", () => {
    const module = buildModule({
      inputs: [
        { name: "x", type: "string", description: "a", required: false },
        { name: "x", type: "string", description: "b", required: false },
      ],
    });
    expect(validateTerraformModule(module).valid).toBe(false);
  });

  it("fails duplicate output names", () => {
    const module = buildModule({
      outputs: [
        { name: "id", description: "a", sensitive: false },
        { name: "id", description: "b", sensitive: false },
      ],
    });
    expect(validateTerraformModule(module).valid).toBe(false);
  });

  it("fails a module that depends on itself", () => {
    const module = buildModule({ name: "vpc", dependencies: ["vpc"] });
    expect(validateTerraformModule(module).valid).toBe(false);
  });

  it("warns on an input with no description", () => {
    const module = buildModule({
      inputs: [{ name: "x", type: "string", description: "", required: false }],
    });
    const result = validateTerraformModule(module);
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("findCircularDependency", () => {
  it("returns null when there is no cycle", () => {
    const modules = [
      buildModule({ name: "vpc", dependencies: [] }),
      buildModule({ name: "eks", dependencies: ["vpc"] }),
    ];
    expect(findCircularDependency(modules)).toBeNull();
  });

  it("detects a direct two-module cycle", () => {
    const modules = [
      buildModule({ name: "a", dependencies: ["b"] }),
      buildModule({ name: "b", dependencies: ["a"] }),
    ];
    expect(findCircularDependency(modules)).not.toBeNull();
  });

  it("detects a longer transitive cycle", () => {
    const modules = [
      buildModule({ name: "a", dependencies: ["b"] }),
      buildModule({ name: "b", dependencies: ["c"] }),
      buildModule({ name: "c", dependencies: ["a"] }),
    ];
    expect(findCircularDependency(modules)).not.toBeNull();
  });
});

describe("validateModuleTest", () => {
  const module = buildModule();

  it("passes a test with all required inputs covered", () => {
    const test: ModuleTest = {
      moduleName: "vpc",
      testCases: [
        {
          name: "creates a VPC",
          inputs: { cidr_block: "10.0.0.0/16" },
          expectedOutputs: { vpc_id: "vpc-123" },
          assertions: ["vpc_id is not empty"],
        },
      ],
    };
    expect(validateModuleTest(test, module).valid).toBe(true);
  });

  it("fails a test with no test cases", () => {
    const test: ModuleTest = { moduleName: "vpc", testCases: [] };
    expect(validateModuleTest(test, module).valid).toBe(false);
  });

  it("fails a test case missing a required input", () => {
    const test: ModuleTest = {
      moduleName: "vpc",
      testCases: [{ name: "missing input", inputs: {}, expectedOutputs: {}, assertions: ["x"] }],
    };
    const result = validateModuleTest(test, module);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/cidr_block/);
  });

  it("warns on a test case with no assertions", () => {
    const test: ModuleTest = {
      moduleName: "vpc",
      testCases: [{ name: "no assertions", inputs: { cidr_block: "x" }, expectedOutputs: {}, assertions: [] }],
    };
    const result = validateModuleTest(test, module);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

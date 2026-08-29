/**
 * Terraform module schema validation (Issue #96).
 */

import type { ModuleTest, TerraformModule } from "./terraformModule.js";

export interface ModuleValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

export function validateTerraformModule(module: TerraformModule): ModuleValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!SEMVER_PATTERN.test(module.version)) {
    errors.push(`Module '${module.name}' has non-semver version "${module.version}"`);
  }

  if (!module.documentation) {
    errors.push(`Module '${module.name}' has no documentation`);
  }

  const inputNames = new Set<string>();
  for (const input of module.inputs) {
    if (inputNames.has(input.name)) {
      errors.push(`Module '${module.name}' declares duplicate input '${input.name}'`);
    }
    inputNames.add(input.name);

    if (input.required && input.default !== undefined) {
      errors.push(
        `Module '${module.name}' input '${input.name}' is required but also declares a default value`,
      );
    }
    if (!input.description) {
      warnings.push(`Module '${module.name}' input '${input.name}' has no description`);
    }
  }

  const outputNames = new Set<string>();
  for (const output of module.outputs) {
    if (outputNames.has(output.name)) {
      errors.push(`Module '${module.name}' declares duplicate output '${output.name}'`);
    }
    outputNames.add(output.name);
  }

  if (module.dependencies.includes(module.name)) {
    errors.push(`Module '${module.name}' declares itself as a dependency`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Detect a circular dependency among a set of modules using DFS. Returns
 * the cycle (module names, in order) if one exists, or null. */
export function findCircularDependency(modules: TerraformModule[]): string[] | null {
  const byName = new Map(modules.map((m) => [m.name, m]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(name: string, path: string[]): string[] | null {
    if (visiting.has(name)) {
      return [...path, name];
    }
    if (visited.has(name)) return null;

    visiting.add(name);
    const module = byName.get(name);
    if (module) {
      for (const dep of module.dependencies) {
        const cycle = visit(dep, [...path, name]);
        if (cycle) return cycle;
      }
    }
    visiting.delete(name);
    visited.add(name);
    return null;
  }

  for (const module of modules) {
    const cycle = visit(module.name, []);
    if (cycle) return cycle;
  }
  return null;
}

export function validateModuleTest(test: ModuleTest, module: TerraformModule): ModuleValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (test.moduleName !== module.name) {
    errors.push(`Test targets module '${test.moduleName}' but was validated against '${module.name}'`);
  }

  if (test.testCases.length === 0) {
    errors.push(`Module '${module.name}' has no test cases`);
  }

  const requiredInputs = module.inputs.filter((i) => i.required).map((i) => i.name);
  for (const testCase of test.testCases) {
    const missing = requiredInputs.filter((name) => !(name in testCase.inputs));
    if (missing.length > 0) {
      errors.push(
        `Test case '${testCase.name}' for module '${module.name}' is missing required inputs: ${missing.join(", ")}`,
      );
    }
    if (testCase.assertions.length === 0) {
      warnings.push(`Test case '${testCase.name}' for module '${module.name}' has no assertions`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

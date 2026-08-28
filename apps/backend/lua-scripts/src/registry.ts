/**
 * Lua script registry with versioning
 * Issue #156
 */

import { createHash } from "node:crypto";
import { createLogger } from "@delegolabs/utils";
import type { LuaScript, ScriptVersion, ScriptRegistry } from "@delegolabs/types";

const log = createLogger("lua-scripts:registry", process.env.LOG_LEVEL ?? "info");

const registry = new Map<string, ScriptRegistry>();
const scripts = new Map<string, LuaScript>();

function computeSha(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

export function registerScript(script: LuaScript): ScriptRegistry {
  const existing = registry.get(script.name);

  const version: ScriptVersion = {
    version: script.version,
    sha: script.sha || computeSha(script.source),
    createdAt: new Date().toISOString(),
    createdBy: "system",
    changelog: `Registered version ${script.version}`,
    status: "active",
  };

  if (existing) {
    existing.versions.forEach((v) => {
      if (v.status === "active") v.status = "deprecated";
    });
    existing.versions.push(version);
    existing.currentVersion = script.version;
    existing.dependencies = script.dependencies;
  } else {
    registry.set(script.name, {
      name: script.name,
      currentVersion: script.version,
      versions: [version],
      dependencies: script.dependencies,
      deploymentStatus: "none",
    });
  }

  scripts.set(`${script.name}:${script.version}`, {
    ...script,
    sha: version.sha,
  });

  log.info("Script registered", { name: script.name, version: script.version, sha: version.sha });
  return registry.get(script.name)!;
}

export function getScript(name: string, version?: string): LuaScript | null {
  const key = version ? `${name}:${version}` : `${name}:${getCurrentVersion(name)}`;
  return scripts.get(key) ?? null;
}

export function getCurrentVersion(name: string): string | null {
  return registry.get(name)?.currentVersion ?? null;
}

export function getScriptRegistry(name: string): ScriptRegistry | null {
  return registry.get(name) ?? null;
}

export function listScripts(): ScriptRegistry[] {
  return Array.from(registry.values());
}

export function deprecateScript(name: string, version: string): boolean {
  const reg = registry.get(name);
  if (!reg) return false;

  const ver = reg.versions.find((v) => v.version === version);
  if (!ver) return false;

  ver.status = "deprecated";
  log.info("Script deprecated", { name, version });
  return true;
}

export function archiveScript(name: string, version: string): boolean {
  const reg = registry.get(name);
  if (!reg) return false;

  const ver = reg.versions.find((v) => v.version === version);
  if (!ver) return false;

  ver.status = "archived";
  log.info("Script archived", { name, version });
  return true;
}

export function getScriptVersions(name: string): ScriptVersion[] {
  return registry.get(name)?.versions ?? [];
}

export function deleteScript(name: string): boolean {
  const reg = registry.get(name);
  if (!reg) return false;

  for (const ver of reg.versions) {
    scripts.delete(`${name}:${ver.version}`);
  }

  registry.delete(name);
  log.info("Script deleted", { name });
  return true;
}

export function rollbackScript(name: string, targetVersion: string): boolean {
  const reg = registry.get(name);
  if (!reg) return false;

  const targetVer = reg.versions.find((v) => v.version === targetVersion);
  if (!targetVer) return false;

  reg.currentVersion = targetVersion;
  log.info("Script rolled back", { name, targetVersion });
  return true;
}

export function validateDependencies(name: string): { valid: boolean; missing: string[] } {
  const reg = registry.get(name);
  if (!reg) return { valid: false, missing: [name] };

  const missing: string[] = [];
  for (const dep of reg.dependencies) {
    if (!registry.has(dep)) {
      missing.push(dep);
    }
  }

  return { valid: missing.length === 0, missing };
}

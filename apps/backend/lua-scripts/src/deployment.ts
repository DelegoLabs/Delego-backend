/**
 * Lua script deployment with atomic updates and rollback
 * Issue #156
 */

import { createHash } from "node:crypto";
import { createLogger } from "@delegolabs/utils";
import { getRedisClient } from "../gateway/src/rateLimit/redisClient.js";
import type { ScriptDeployment, ScriptMetrics } from "@delegolabs/types";
import { getScript, getCurrentVersion, getScriptRegistry, rollbackScript } from "./registry.js";

const log = createLogger("lua-scripts:deploy", process.env.LOG_LEVEL ?? "info");

const deployments = new Map<string, ScriptDeployment>();
const metrics = new Map<string, ScriptMetrics>();

function computeSha(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

export async function deployScript(
  name: string,
  version: string,
  deployedBy: string,
  clusters: string[] = ["default"]
): Promise<ScriptDeployment> {
  const script = getScript(name, version);
  if (!script) {
    throw new Error(`Script ${name} v${version} not found`);
  }

  const deployment: ScriptDeployment = {
    scriptName: name,
    version,
    status: "deploying",
    deployedAt: new Date().toISOString(),
    deployedBy,
    clusters,
  };

  deployments.set(`${name}:${version}`, deployment);

  try {
    const redis = getRedisClient();
    const sha = computeSha(script.source);

    await redis.eval(
      `redis.call('SCRIPT', 'LOAD', ARGV[1])`,
      0,
      script.source
    );

    deployment.status = "deployed";
    deployment.deployedAt = new Date().toISOString();

    const reg = getScriptRegistry(name);
    if (reg) {
      reg.lastDeployedAt = deployment.deployedAt;
      reg.deploymentStatus = "deployed";
    }

    log.info("Script deployed", { name, version, sha, deployedBy, clusters });
  } catch (err) {
    deployment.status = "failed";
    log.error("Script deployment failed", {
      name,
      version,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  return deployment;
}

export async function rollbackDeployment(
  name: string,
  targetVersion: string,
  rolledBackBy: string
): Promise<ScriptDeployment> {
  const currentDeployment = deployments.get(`${name}:${getCurrentVersion(name) ?? ""}`);
  if (currentDeployment) {
    currentDeployment.status = "rolled_back";
    currentDeployment.rollbackVersion = targetVersion;
  }

  const success = rollbackScript(name, targetVersion);
  if (!success) {
    throw new Error(`Failed to rollback to version ${targetVersion}`);
  }

  const deployment = await deployScript(name, targetVersion, rolledBackBy);
  log.info("Script rollback completed", { name, targetVersion, rolledBackBy });
  return deployment;
}

export function getDeployment(name: string, version: string): ScriptDeployment | null {
  return deployments.get(`${name}:${version}`) ?? null;
}

export function getLatestDeployment(name: string): ScriptDeployment | null {
  const allDeployments = Array.from(deployments.values())
    .filter((d) => d.scriptName === name)
    .sort((a, b) => Date.parse(b.deployedAt) - Date.parse(a.deployedAt));
  return allDeployments[0] ?? null;
}

export function listDeployments(): ScriptDeployment[] {
  return Array.from(deployments.values());
}

export async function executeScript(
  name: string,
  keys: string[],
  args: unknown[]
): Promise<unknown> {
  const version = getCurrentVersion(name);
  if (!version) {
    throw new Error(`No active version for script ${name}`);
  }

  const script = getScript(name, version);
  if (!script) {
    throw new Error(`Script ${name} v${version} not found`);
  }

  const startTime = performance.now();
  let success = true;

  try {
    const redis = getRedisClient();
    const result = await redis.eval(script.source, keys.length, ...keys, ...args.map(String));
    return result;
  } catch (err) {
    success = false;
    throw err;
  } finally {
    const durationMs = performance.now() - startTime;
    updateMetrics(name, version, durationMs, success);
  }
}

function updateMetrics(name: string, version: string, durationMs: number, success: boolean): void {
  const key = `${name}:${version}`;
  const existing = metrics.get(key);

  if (existing) {
    existing.executions += 1;
    existing.avgDurationMs = (existing.avgDurationMs * (existing.executions - 1) + durationMs) / existing.executions;
    existing.p99DurationMs = Math.max(existing.p99DurationMs, durationMs);
    if (!success) existing.errors += 1;
    existing.errorRate = existing.errors / existing.executions;
    existing.lastExecutedAt = new Date().toISOString();
  } else {
    metrics.set(key, {
      scriptName: name,
      version,
      executions: 1,
      avgDurationMs: durationMs,
      p99DurationMs: durationMs,
      errors: success ? 0 : 1,
      errorRate: success ? 0 : 1,
      lastExecutedAt: new Date().toISOString(),
    });
  }
}

export function getScriptMetrics(name: string, version?: string): ScriptMetrics[] {
  const prefix = version ? `${name}:${version}` : name;
  return Array.from(metrics.values()).filter(
    (m) => m.scriptName === name && (!version || m.version === version)
  );
}

export function clearMetrics(name?: string): void {
  if (name) {
    for (const [key] of metrics) {
      if (key.startsWith(name)) metrics.delete(key);
    }
  } else {
    metrics.clear();
  }
}

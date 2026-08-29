import { json, route, type Route } from "@delegolabs/utils";
import type { DistributedLockManager } from "./manager.js";
import { lockAlertRules } from "./metrics.js";

function decodeLockKey(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function createLockRoutes(manager: DistributedLockManager): Route[] {
  return [
    route("GET", "/locks/metrics", async (_req, res) => {
      json(res, 200, {
        data: {
          owner: manager.owner,
          held: manager.listHeld(),
          snapshot: manager.metrics.snapshot(),
          alerts: lockAlertRules(),
        },
        error: null,
      });
    }),

    route("GET", "/locks", async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const prefix = url.searchParams.get("prefix") ?? "lock:";
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
      const scanned = await manager.scan(prefix, limit);
      json(res, 200, {
        data: {
          owner: manager.owner,
          held: manager.listHeld(),
          keys: scanned,
        },
        error: null,
      });
    }),

    route("GET", "/locks/:key", async (_req, res, params) => {
      const key = decodeLockKey(params.key);
      const inspected = await manager.inspect(key);
      if (!inspected.lock) {
        json(res, 404, {
          data: null,
          error: { code: "NOT_FOUND", message: `Lock not found: ${key}` },
        });
        return;
      }
      json(res, 200, {
        data: { lock: inspected.lock, pttlMs: inspected.pttlMs, stolen: manager.wasStolen(key) },
        error: null,
      });
    }),
  ];
}

/**
 * HTTP routes for chat-archival service.
 */
import { json, route, type Route } from "@delegolabs/utils";
import { createLogger } from "@delegolabs/utils";
import type { ChatArchivalWorker } from "./worker.js";

const log = createLogger("chat-archival:routes", process.env.LOG_LEVEL ?? "info");

export function registerRoutes(worker: ChatArchivalWorker | null): Route[] {
  return [
    route("POST", "/api/v1/chat-archival/trigger", async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const olderThanDays = body.olderThanDays ?? 30;
        const batchSize = body.batchSize ?? 100;
        const dryRun = body.dryRun ?? false;

        if (!worker) {
          json(res, 503, { data: null, error: { code: "WORKER_UNAVAILABLE", message: "Worker not available" } });
          return;
        }

        log.info("Manual archival trigger", { olderThanDays, batchSize, dryRun });
        await worker.scheduleBatchArchival(olderThanDays, batchSize, dryRun);

        json(res, 202, {
          data: { message: "Archival job scheduled", olderThanDays, batchSize, dryRun },
          error: null,
        });
      } catch (error) {
        log.error("Failed to trigger archival", { error: (error as Error).message });
        json(res, 500, { data: null, error: { code: "TRIGGER_FAILED", message: (error as Error).message } });
      }
    }),

    route("GET", "/api/v1/chat-archival/status", async (_req, res) => {
      json(res, 200, {
        data: {
          status: "ok",
          workerAvailable: worker !== null,
          timestamp: new Date().toISOString(),
        },
        error: null,
      });
    }),
  ];
}

async function readJsonBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: any) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

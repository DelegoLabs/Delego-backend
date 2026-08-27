/**
 * Transaction Batching — HTTP routes
 * Issue #42
 *
 * POST /transactions/batch           – submit batch
 * GET  /transactions/batch/:batchId  – get batch status / result
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { route, json, type Route } from "@delegolabs/utils";
import { submitBatch, getBatchStatus } from "./batchQueue.js";

async function readBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as T) : ({} as T));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function handleError(res: ServerResponse, err: unknown): void {
  const message = err instanceof Error ? err.message : "Unknown error";
  const status = message.toLowerCase().includes("not found") ? 404 : 400;
  json(res, status, { data: null, error: { code: "BATCH_ERROR", message } });
}

export function registerBatchingRoutes(): Route[] {
  return [
    // Submit batch
    route("POST", "/transactions/batch", async (req, res) => {
      try {
        const body = await readBody(req);
        const result = await submitBatch(
          body as Parameters<typeof submitBatch>[0],
        );
        json(res, 202, { data: result, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // Get batch status / result
    route("GET", "/transactions/batch/:batchId", async (_req, res, params) => {
      try {
        const result = await getBatchStatus(params.batchId);
        json(res, 200, { data: result, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),
  ];
}

/**
 * Shared JSON body reader for the notifications HTTP routes (#27).
 *
 * Extracted from index.ts so it can be unit tested without importing that
 * module, which starts the HTTP server, DB connection, and event listeners
 * as a side effect of being loaded.
 *
 * Body is capped at 1MB (see readBodyWithLimit) — an oversized body rejects
 * with PayloadTooLargeError, which the shared HTTP server (startHttpServer)
 * catches and responds to with 413, since these routes don't wrap
 * readBody in their own try/catch.
 */
import type { IncomingMessage } from "node:http";
import { readBodyWithLimit } from "@delegolabs/utils";

export async function readBody(req: IncomingMessage): Promise<unknown> {
  const data = await readBodyWithLimit(req);
  try {
    return JSON.parse(data);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

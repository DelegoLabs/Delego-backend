import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getLogContext, runWithLogContext } from "@delegolabs/utils";

export function correlationMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
): void {
  const incoming = req.headers["x-correlation-id"];
  const correlationId = (Array.isArray(incoming) ? incoming[0] : incoming)?.trim() || randomUUID();

  res.setHeader("X-Correlation-ID", correlationId);
  runWithLogContext({ correlationId }, next);
}

export function fetchWithCorrelation(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const correlationId = getLogContext().correlationId;
  if (!correlationId) {
    return fetchImpl(input, init);
  }

  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  headers.set("X-Correlation-ID", correlationId);

  return fetchImpl(input, { ...init, headers });
}
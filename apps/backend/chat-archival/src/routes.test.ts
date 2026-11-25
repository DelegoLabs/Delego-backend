import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerRoutes } from "./routes.js";

type Worker = NonNullable<Parameters<typeof registerRoutes>[0]>;
const scheduleBatchArchival = vi.fn<Worker["scheduleBatchArchival"]>();
const worker = { scheduleBatchArchival } as Worker;

async function request(
  routeWorker: Worker | null,
  method: string,
  path: string,
  body?: string,
) {
  const route = registerRoutes(routeWorker).find((route) => route.method === method && route.pattern.test(path));
  if (!route) throw new Error(`Route not registered: ${method} ${path}`);

  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as IncomingMessage;
  const writeHead = vi.fn();
  const end = vi.fn<(body: string) => void>();
  await route.handler(req, { writeHead, end } as unknown as ServerResponse, {});

  expect(writeHead).toHaveBeenCalledOnce();
  expect(end).toHaveBeenCalledOnce();
  return { status: writeHead.mock.calls[0]![0], body: JSON.parse(end.mock.calls[0]![0]) };
}

const trigger = "/api/v1/chat-archival/trigger";
const status = "/api/v1/chat-archival/status";

beforeEach(() => {
  scheduleBatchArchival.mockReset();
  scheduleBatchArchival.mockResolvedValue(undefined);
});

describe("chat archival HTTP routes", () => {
  it.each([
    { input: {}, options: { olderThanDays: 30, batchSize: 100, dryRun: false } },
    {
      input: { olderThanDays: 7, batchSize: 20, dryRun: true },
      options: { olderThanDays: 7, batchSize: 20, dryRun: true },
    },
  ])("schedules archival and returns the effective options for $input", async ({ input, options }) => {
    const response = await request(worker, "POST", trigger, JSON.stringify(input));

    expect(scheduleBatchArchival).toHaveBeenCalledOnce();
    expect(scheduleBatchArchival).toHaveBeenCalledWith(options.olderThanDays, options.batchSize, options.dryRun);
    expect(response).toEqual({
      status: 202,
      body: { data: { message: "Archival job scheduled", ...options }, error: null },
    });
  });

  it("returns unavailable when no worker can schedule the job", async () => {
    const response = await request(null, "POST", trigger, "{}");

    expect(response).toMatchObject({ status: 503, body: { data: null, error: { code: "WORKER_UNAVAILABLE" } } });
    expect(scheduleBatchArchival).not.toHaveBeenCalled();
  });

  it("reports malformed JSON without scheduling a job", async () => {
    const response = await request(worker, "POST", trigger, "{");

    expect(response).toMatchObject({ status: 500, body: { data: null, error: { code: "TRIGGER_FAILED" } } });
    expect(scheduleBatchArchival).not.toHaveBeenCalled();
  });

  it("reports a scheduling failure", async () => {
    scheduleBatchArchival.mockRejectedValue(new Error("Queue unavailable"));

    const response = await request(worker, "POST", trigger, "{}");

    expect(response).toEqual({
      status: 500,
      body: { data: null, error: { code: "TRIGGER_FAILED", message: "Queue unavailable" } },
    });
  });

  it.each([true, false])("reports worker availability as %s", async (available) => {
    const response = await request(available ? worker : null, "GET", status);

    expect(response).toMatchObject({ status: 200, body: { data: { status: "ok", workerAvailable: available }, error: null } });
    const timestamp = response.body.data.timestamp;
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });
});

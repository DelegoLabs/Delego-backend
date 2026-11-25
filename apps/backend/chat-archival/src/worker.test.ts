import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatArchivalWorker } from "./worker.js";
import type { ChatArchivalJobData, ChatArchivalJobResult } from "./types.js";

type JobProcessor = (job: { data: ChatArchivalJobData }) => Promise<ChatArchivalJobResult>;

const queue = vi.hoisted(() => ({
  processor: vi.fn<WorkerProcessorCapture>(),
  on: vi.fn(),
  closeWorker: vi.fn(),
  closeQueue: vi.fn(),
  closeEvents: vi.fn(),
  quitRedis: vi.fn(),
}));

type WorkerProcessorCapture = (processor: JobProcessor) => void;

vi.mock("bullmq", () => ({
  Worker: class {
    constructor(_name: string, processor: JobProcessor) {
      queue.processor(processor);
    }
    on = queue.on;
    close = queue.closeWorker;
  },
  Queue: class {
    close = queue.closeQueue;
  },
  QueueEvents: class {
    close = queue.closeEvents;
  },
}));

vi.mock("ioredis", () => ({
  Redis: class {
    quit = queue.quitRedis;
  },
}));

const result: ChatArchivalJobResult = {
  success: true,
  sessionId: "session-1",
  messageCount: 3,
};

const archiveSession = vi.fn<ConstructorParameters<typeof ChatArchivalWorker>[0]["archiveSession"]>();

function startWorker(config: ConstructorParameters<typeof ChatArchivalWorker>[1] = {}) {
  const worker = new ChatArchivalWorker({
    archiveSession,
    findAndArchiveIdleSessions: vi.fn(),
    database: {
      findIdleSessions: vi.fn(),
      getSessionById: vi.fn(),
      getSessionMessages: vi.fn(),
      saveArchivalSummary: vi.fn(),
      updateSessionArchived: vi.fn(),
      deleteSessionMessages: vi.fn(),
    },
  }, config);
  return { worker, process: queue.processor.mock.calls[0]![0] };
}

beforeEach(() => {
  vi.resetAllMocks();
  archiveSession.mockResolvedValue(result);
});

describe("ChatArchivalWorker", () => {
  it.each([
    { config: {}, job: {}, expected: false },
    { config: { dryRun: true }, job: {}, expected: true },
    { config: { dryRun: true }, job: { dryRun: false }, expected: false },
    { config: { dryRun: false }, job: { dryRun: true }, expected: true },
  ])("uses dry-run value $expected for job $job and config $config", async ({ config, job, expected }) => {
    const { process } = startWorker(config);

    await expect(process({ data: { sessionId: result.sessionId, ...job } })).resolves.toEqual(result);
    expect(archiveSession).toHaveBeenCalledWith(result.sessionId, expected);
  });

  it.each([
    { error: "Storage unavailable", message: "Storage unavailable" },
    { error: undefined, message: "Archival failed" },
  ])("rejects an unsuccessful archival with $message", async ({ error, message }) => {
    archiveSession.mockResolvedValue({ ...result, success: false, error });
    const { process } = startWorker();

    await expect(process({ data: { sessionId: result.sessionId } })).rejects.toThrow(message);
  });

  it("propagates errors from the archival service to BullMQ", async () => {
    const error = new Error("Archival service unavailable");
    archiveSession.mockRejectedValue(error);
    const { process } = startWorker();

    await expect(process({ data: { sessionId: result.sessionId } })).rejects.toBe(error);
  });

  it("waits for the worker to stop before closing queue resources and Redis", async () => {
    const { worker } = startWorker();
    let finishWorker: () => void = () => {};
    queue.closeWorker.mockReturnValue(new Promise<void>((resolve) => { finishWorker = resolve; }));

    const closing = worker.close();
    expect(queue.closeWorker).toHaveBeenCalledOnce();
    expect(queue.closeQueue).not.toHaveBeenCalled();
    expect(queue.closeEvents).not.toHaveBeenCalled();
    expect(queue.quitRedis).not.toHaveBeenCalled();

    finishWorker();
    await closing;

    expect(queue.closeQueue).toHaveBeenCalledOnce();
    expect(queue.closeEvents).toHaveBeenCalledOnce();
    expect(queue.quitRedis).toHaveBeenCalledOnce();
    expect(queue.closeEvents.mock.invocationCallOrder[0]).toBeLessThan(queue.quitRedis.mock.invocationCallOrder[0]!);
  });
});

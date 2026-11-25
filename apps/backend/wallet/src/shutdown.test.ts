import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWalletShutdown } from "./shutdown.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const server = createServer();
  let onHttpClosed: ((error?: Error) => void) | undefined;
  const closeHttp = vi.spyOn(server, "close").mockImplementation((callback) => {
    onHttpClosed = callback;
    return server;
  });
  const forceCloseHttp = vi.spyOn(server, "closeAllConnections");
  const stopWebSocketServer = vi.fn<() => void | Promise<void>>();
  const stopTimers = vi.fn<() => void>();
  const stopCron = vi.fn<() => void>();
  const closePathQuoteService = vi.fn<() => void>();
  const closeQueue = vi.fn<() => void | Promise<void>>();
  const log = { info: vi.fn(), error: vi.fn() };
  const exit = vi.fn();
  const shutdown = createWalletShutdown({
    server,
    stopWebSocketServer,
    backgroundTasks: [
      { name: "batch-flush-timers", stop: stopTimers },
      { name: "merchant-domain-reverification", stop: stopCron },
    ],
    closePathQuoteService,
    closeQueue,
    log,
    exit,
    timeoutMs: 100,
  });

  return {
    shutdown, closeHttp, forceCloseHttp, stopWebSocketServer, stopTimers,
    stopCron, closePathQuoteService, closeQueue, log, exit,
    finishHttp: (error?: Error) => onHttpClosed!(error),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("wallet shutdown", () => {
  it.each(["http", "websocket"])("keeps dependencies open while %s is still draining", async (lastServer) => {
    vi.useFakeTimers();
    const deps = setup();
    const ws = deferred();
    const queueClosed = deferred();
    const queueClosing = deferred();
    deps.stopWebSocketServer.mockReturnValue(ws.promise);
    deps.closeQueue.mockImplementation(() => {
      queueClosing.resolve();
      return queueClosed.promise;
    });

    const closing = deps.shutdown("SIGTERM");
    expect(deps.shutdown("SIGINT")).toBe(closing);
    expect(deps.closeHttp).toHaveBeenCalledOnce();
    expect(deps.stopWebSocketServer).toHaveBeenCalledOnce();
    expect(deps.stopTimers).toHaveBeenCalledOnce();

    const finishLast = lastServer === "http" ? deps.finishHttp : ws.resolve;
    const finishFirst = lastServer === "http" ? ws.resolve : deps.finishHttp;
    finishFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.closePathQuoteService).not.toHaveBeenCalled();
    expect(deps.closeQueue).not.toHaveBeenCalled();

    finishLast();
    await queueClosing.promise;
    expect(deps.closePathQuoteService).toHaveBeenCalledOnce();
    expect(deps.closeQueue).toHaveBeenCalledOnce();
    expect(deps.closePathQuoteService.mock.invocationCallOrder[0]).toBeLessThan(
      deps.closeQueue.mock.invocationCallOrder[0]!,
    );
    expect(deps.exit).not.toHaveBeenCalled();

    queueClosed.resolve();
    await closing;
    expect(deps.exit).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledWith(0);
    expect(deps.forceCloseHttp).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues cleanup when listeners and background tasks fail", async () => {
    const deps = setup();
    deps.stopWebSocketServer.mockRejectedValue(new Error("websocket failure"));
    deps.stopTimers.mockImplementation(() => { throw new Error("timer failure"); });
    deps.closePathQuoteService.mockImplementation(() => { throw new Error("Horizon failure"); });

    const closing = deps.shutdown("SIGINT");
    deps.finishHttp(new Error("HTTP failure"));
    await closing;

    expect(deps.stopCron).toHaveBeenCalledOnce();
    expect(deps.closeQueue).toHaveBeenCalledOnce();
    expect(deps.log.error.mock.calls.map(([, details]) => details.step).sort()).toEqual([
      "batch-flush-timers", "http", "path-quotes", "websocket",
    ]);
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it("force-closes HTTP and exits unsuccessfully at the deadline", async () => {
    vi.useFakeTimers();
    const deps = setup();
    const closing = deps.shutdown("SIGTERM");

    await vi.advanceTimersByTimeAsync(100);
    await closing;

    expect(deps.forceCloseHttp).toHaveBeenCalledOnce();
    expect(deps.closeQueue).not.toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

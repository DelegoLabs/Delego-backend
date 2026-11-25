import type { Server } from "node:http";
import type { Logger } from "@delegolabs/utils";

const SHUTDOWN_TIMEOUT_MS = 10_000;

type Cleanup = () => void | Promise<void>;

interface ShutdownDependencies {
  server: Pick<Server, "close" | "closeAllConnections">;
  stopWebSocketServer: Cleanup;
  backgroundTasks: ReadonlyArray<{ name: string; stop: Cleanup }>;
  closePathQuoteService: Cleanup;
  closeQueue: Cleanup;
  log: Pick<Logger, "info" | "error">;
  exit: (code: number) => void;
  timeoutMs?: number;
}

export function createWalletShutdown({
  server,
  stopWebSocketServer,
  backgroundTasks,
  closePathQuoteService,
  closeQueue,
  log,
  exit,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
}: ShutdownDependencies): (signal: NodeJS.Signals) => Promise<void> {
  let shutdown: Promise<void> | undefined;

  async function run(signal: NodeJS.Signals): Promise<void> {
    const startedAt = Date.now();
    let failed = false;
    let timedOut = false;

    async function cleanUp(step: string, action: Cleanup): Promise<void> {
      try {
        await action();
      } catch (error) {
        failed = true;
        log.error("Wallet shutdown step failed", {
          signal,
          step,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    async function drain(): Promise<void> {
      const httpClosed = cleanUp("http", () => new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      }));
      const webSocketClosed = cleanUp("websocket", stopWebSocketServer);

      for (const { name, stop } of backgroundTasks) {
        if (timedOut) return;
        await cleanUp(name, stop);
      }

      await Promise.all([httpClosed, webSocketClosed]);
      if (timedOut) return;
      // In-flight HTTP requests can still need Horizon and the transaction queue.
      await cleanUp("path-quotes", closePathQuoteService);
      if (timedOut) return;
      await cleanUp("transaction-queue", closeQueue);
    }

    log.info("Wallet shutdown started", { signal, timeoutMs });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        log.error("Wallet shutdown deadline exceeded", { signal, timeoutMs });
        // Force lingering HTTP sockets closed. The process exit also bounds
        // resources that cannot be safely interrupted during graceful cleanup.
        void cleanUp("force-close-http", () => server.closeAllConnections()).then(resolve);
      }, timeoutMs);
    });

    try {
      await Promise.race([drain(), deadline]);
    } finally {
      clearTimeout(timer);
    }

    const exitCode = failed || timedOut ? 1 : 0;
    log.info("Wallet shutdown finished", {
      signal,
      exitCode,
      durationMs: Date.now() - startedAt,
    });
    exit(exitCode);
  }

  return (signal) => {
    shutdown ??= run(signal);
    return shutdown;
  };
}

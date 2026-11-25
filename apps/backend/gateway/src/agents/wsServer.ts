/**
 * Issue #530 — WebSocket server bootstrap for buyer-agent interactive sessions.
 *
 * Attaches a `ws.WebSocketServer` to an existing `node:http.Server` and
 * routes upgrade requests on `/ws/agent` to `handleAgentConnection`.
 *
 * Usage:
 *
 *   ```ts
 *   import { createServer } from "node:http";
 *   import { attachAgentWebSocketServer } from "./agents/wsServer.js";
 *
 *   const httpServer = createServer(app);
 *   attachAgentWebSocketServer(httpServer);
 *   httpServer.listen(3000);
 *   ```
 *
 * The gateway's `startHttpServer` returns the underlying `http.Server`, so
 * `attachAgentWebSocketServer` is called on its return value in `index.ts`.
 */

import { WebSocketServer } from "ws";
import type { IncomingMessage, Server } from "node:http";
import { createLogger } from "@delegolabs/utils";
import { handleAgentConnection } from "./wsHandler.js";

const log = createLogger("gateway:ws-server", process.env.LOG_LEVEL ?? "info");

/** The URL path on which agent WebSocket upgrades are accepted. */
const AGENT_WS_PATH = "/ws/agent";

/**
 * Attach the agent WebSocket server to an existing HTTP server.
 *
 * Returns the `WebSocketServer` instance so callers can close it cleanly
 * during graceful shutdown.
 */
export function attachAgentWebSocketServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request: IncomingMessage, socket: import("node:net").Socket, head: Buffer) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (url.pathname !== AGENT_WS_PATH) {
      // Not our path; let other upgrade handlers (if any) handle it.
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", handleAgentConnection);

  wss.on("error", (err: Error) => {
    log.error("WebSocketServer error", { error: err.message });
  });

  log.info(`Agent WebSocket server attached at ${AGENT_WS_PATH}`);

  return wss;
}

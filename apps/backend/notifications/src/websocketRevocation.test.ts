import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import WebSocket, { type RawData } from "ws";
import jwt from "jsonwebtoken";

const TEST_JWT_SECRET = "test-jwt-secret";

describe("notifications websocket session revocation", () => {
  let server: Server;
  let wss: { close(): void } | undefined;
  let port = 0;
  let websocketModule: typeof import("./websocket.js");
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.MOCK_REDIS = "true";
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    vi.resetModules();
    websocketModule = await import("./websocket.js");

    server = createServer();
    wss = websocketModule.initWebSocketServer(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  afterAll(async () => {
    process.env = { ...originalEnv };
    wss?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function connect(userId: string): Promise<WebSocket> {
    const token = jwt.sign({ userId }, TEST_JWT_SECRET, { expiresIn: "1h" });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    return new Promise<WebSocket>((resolve, reject) => {
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  function nextPong(ws: WebSocket): Promise<void> {
    return new Promise<void>((resolve) => {
      const onMessage = (data: RawData) => {
        try {
          const message = JSON.parse(data.toString()) as { type?: string };
          if (message.type === "pong") {
            ws.off("message", onMessage);
            resolve();
          }
        } catch {
          // Ignore malformed frames in this focused test.
        }
      };
      ws.on("message", onMessage);
      ws.send(JSON.stringify({ type: "ping" }));
    });
  }

  it("closes only the revoked user's WebSocket connections", async () => {
    const revoked = await connect("user-ws-revoked");
    const kept = await connect("user-ws-kept");
    await Promise.all([nextPong(revoked), nextPong(kept)]);

    try {
      const revokedClosed = new Promise<number>((resolve) => {
        revoked.once("close", (code) => resolve(code));
      });

      websocketModule.handleSessionRevocationMessage(
        JSON.stringify({ userId: "user-ws-revoked" }),
      );

      await expect(revokedClosed).resolves.toBe(4401);
      expect(kept.readyState).toBe(WebSocket.OPEN);
    } finally {
      revoked.terminate();
      kept.terminate();
    }
  });
});

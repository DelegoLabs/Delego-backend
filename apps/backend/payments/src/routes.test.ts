/**
 * Unit tests for the request body size limit on readJsonBody (#28).
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { registerRoutes } from "./routes.js";
import type { Route } from "@delegolabs/utils";

type MockResponse = ServerResponse & { statusCode: number; body: string };

function createMockReq(body: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = { "content-type": "application/json" };
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function createMockRes(): MockResponse {
  const res = {
    statusCode: 0,
    body: "",
    writeHead(status: number) {
      this.statusCode = status;
    },
    end(body?: string) {
      if (body !== undefined) this.body = body;
    },
  };
  return res as MockResponse;
}

function findInitializeRoute(): Route {
  const route = registerRoutes().find(
    (r) => r.method === "POST" && r.pattern.test("/escrow/initialize")
  );
  if (!route) throw new Error("escrow/initialize route not registered");
  return route;
}

describe("POST /escrow/initialize body size limit", () => {
  it("reads and parses a body under the 1MB limit (no 413)", async () => {
    const route = findInitializeRoute();
    const req = createMockReq(JSON.stringify({}));
    const res = createMockRes();

    await route.handler(req, res, {});

    // Body was parsed successfully; request fails validation for missing
    // fields (400 VALIDATION_ERROR), not size (413).
    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).not.toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects a body over the 1MB limit with 413 Payload Too Large", async () => {
    const route = findInitializeRoute();
    const oversizedBody = JSON.stringify({ padding: "a".repeat(1024 * 1024 + 1) });
    const req = createMockReq(oversizedBody);
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(413);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(parsed.error.message).toContain("1048576");
  });
});

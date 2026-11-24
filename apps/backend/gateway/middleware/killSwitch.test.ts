import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

const mockIsTrafficPaused = vi.fn<() => boolean>();

vi.mock("../src/emergency/killSwitch.js", () => ({
  getEmergencyKillSwitchService: () => ({
    isTrafficPaused: mockIsTrafficPaused,
  }),
}));

import { killSwitchMiddleware } from "./killSwitch.js";

type MockResponse = ServerResponse & {
  statusCode: number;
  body: string;
};

function createMockReq(url: string): IncomingMessage {
  return {
    url,
    method: "GET",
    headers: {},
  } as unknown as IncomingMessage;
}

function createMockRes(): MockResponse {
  const res = {
    statusCode: 0,
    body: "",
    setHeader() {},
    writeHead(status: number) {
      this.statusCode = status;
    },
    end(body?: string) {
      if (body !== undefined) this.body = body;
    },
  };
  return res as unknown as MockResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("killSwitchMiddleware", () => {
  it("returns 503 and false when the emergency kill-switch is active", async () => {
    mockIsTrafficPaused.mockReturnValue(true);
    const req = createMockReq("/api/v1/orders");
    const res = createMockRes();

    const allowed = await killSwitchMiddleware()(req, res);

    expect(allowed).toBe(false);
    expect(res.statusCode).toBe(503);
    const parsed = JSON.parse(res.body);
    expect(parsed.data).toBeNull();
    expect(parsed.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(parsed.error.message).toContain("Emergency kill-switch is active");
  });

  it("returns true without writing a response when the kill-switch is inactive", async () => {
    mockIsTrafficPaused.mockReturnValue(false);
    const req = createMockReq("/api/v1/orders");
    const res = createMockRes();

    const allowed = await killSwitchMiddleware()(req, res);

    expect(allowed).toBe(true);
    expect(res.statusCode).toBe(0);
    expect(res.body).toBe("");
  });

  it.each([
    "/health",
    "/health/live",
    "/api/v1/health",
    "/api/v1/admin/emergency/resume",
  ])("allows excluded route %s even when kill-switch is active", async (url) => {
    mockIsTrafficPaused.mockReturnValue(true);
    const req = createMockReq(url);
    const res = createMockRes();

    const allowed = await killSwitchMiddleware()(req, res);

    expect(allowed).toBe(true);
    expect(res.statusCode).toBe(0);
    expect(mockIsTrafficPaused).not.toHaveBeenCalled();
  });
});

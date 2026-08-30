import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../middleware/auth.js", () => ({
  getAuthenticatedUserContext: vi.fn(),
}));

import { getAuthenticatedUserContext } from "../../../middleware/auth.js";
import { resolveTier } from "./tierResolver.js";

function mockReq(headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = headers;
  return req;
}

describe("resolveTier", () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUserContext).mockReset();
    delete process.env.INTERNAL_SERVICE_KEY;
  });

  afterEach(() => {
    delete process.env.INTERNAL_SERVICE_KEY;
  });

  it("defaults to 'free' for anonymous requests", () => {
    vi.mocked(getAuthenticatedUserContext).mockReturnValue(undefined);
    expect(resolveTier(mockReq())).toBe("free");
  });

  it("derives tier from the authenticated user's roles", () => {
    vi.mocked(getAuthenticatedUserContext).mockReturnValue({
      userId: "u1",
      email: "a@b.com",
      roles: ["pro"],
    });
    expect(resolveTier(mockReq())).toBe("pro");

    vi.mocked(getAuthenticatedUserContext).mockReturnValue({
      userId: "u1",
      email: "a@b.com",
      roles: ["enterprise"],
    });
    expect(resolveTier(mockReq())).toBe("enterprise");
  });

  it("defaults an authenticated user with no special role to 'free'", () => {
    vi.mocked(getAuthenticatedUserContext).mockReturnValue({
      userId: "u1",
      email: "a@b.com",
      roles: ["user"],
    });
    expect(resolveTier(mockReq())).toBe("free");
  });

  it("grants 'internal' only when the shared service key header matches", () => {
    process.env.INTERNAL_SERVICE_KEY = "top-secret";
    vi.mocked(getAuthenticatedUserContext).mockReturnValue(undefined);

    expect(resolveTier(mockReq({ "x-internal-service-key": "top-secret" }))).toBe("internal");
    expect(resolveTier(mockReq({ "x-internal-service-key": "wrong" }))).toBe("free");
    expect(resolveTier(mockReq())).toBe("free");
  });

  it("never grants 'internal' from a client-supplied header when no server key is configured", () => {
    vi.mocked(getAuthenticatedUserContext).mockReturnValue(undefined);
    expect(resolveTier(mockReq({ "x-internal-service-key": "anything" }))).toBe("free");
  });
});

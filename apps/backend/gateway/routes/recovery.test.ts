import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Route } from "@delegolabs/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserContext: vi.fn(),
  readJsonBody: vi.fn(),
  getRecoveryConfig: vi.fn(),
  createRecoveryConfig: vi.fn(),
  updateRecoveryConfig: vi.fn(),
  addGuardian: vi.fn(),
  removeGuardian: vi.fn(),
  verifyGuardian: vi.fn(),
  addEmergencyContact: vi.fn(),
  removeEmergencyContact: vi.fn(),
  initiateRecovery: vi.fn(),
  processGuardianApproval: vi.fn(),
  rejectRecovery: vi.fn(),
  cancelRecovery: vi.fn(),
  completeRecovery: vi.fn(),
  listRecoveryRequests: vi.fn(),
  getRecoveryProgress: vi.fn(),
  isRecoverable: vi.fn(),
}));

vi.mock("../middleware/auth.js", () => ({
  getAuthenticatedUserContext: mocks.getAuthenticatedUserContext,
}));

vi.mock("../src/request.js", () => ({
  readJsonBody: mocks.readJsonBody,
}));

vi.mock("../src/recovery/service.js", () => ({
  getRecoveryConfig: mocks.getRecoveryConfig,
  createRecoveryConfig: mocks.createRecoveryConfig,
  updateRecoveryConfig: mocks.updateRecoveryConfig,
  addGuardian: mocks.addGuardian,
  removeGuardian: mocks.removeGuardian,
  verifyGuardian: mocks.verifyGuardian,
  addEmergencyContact: mocks.addEmergencyContact,
  removeEmergencyContact: mocks.removeEmergencyContact,
  initiateRecovery: mocks.initiateRecovery,
  processGuardianApproval: mocks.processGuardianApproval,
  rejectRecovery: mocks.rejectRecovery,
  cancelRecovery: mocks.cancelRecovery,
  completeRecovery: mocks.completeRecovery,
  listRecoveryRequests: mocks.listRecoveryRequests,
  getRecoveryProgress: mocks.getRecoveryProgress,
  isRecoverable: mocks.isRecoverable,
}));

import { registerRecoveryRoutes } from "./recovery.js";
import {
  getRecoveryConfigHandler,
  createRecoveryConfigHandler,
  updateRecoveryConfigHandler,
  addGuardianHandler,
  removeGuardianHandler,
  verifyGuardianHandler,
  addEmergencyContactHandler,
  removeEmergencyContactHandler,
  initiateRecoveryHandler,
  processGuardianApprovalHandler,
  rejectRecoveryHandler,
  cancelRecoveryHandler,
  completeRecoveryHandler,
  listRecoveryRequestsHandler,
  getRecoveryProgressHandler,
  isRecoverableHandler,
} from "../src/recovery/routes.js";

type TestResponse = ServerResponse & { body: string };

const expectedRoutes: Array<{
  method: string;
  path: string;
  paramNames: string[];
  handler: Route["handler"];
}> = [
  {
    method: "GET",
    path: "/api/v1/recovery/config",
    paramNames: [],
    handler: getRecoveryConfigHandler,
  },
  {
    method: "POST",
    path: "/api/v1/recovery/config",
    paramNames: [],
    handler: createRecoveryConfigHandler,
  },
  {
    method: "PATCH",
    path: "/api/v1/recovery/config",
    paramNames: [],
    handler: updateRecoveryConfigHandler,
  },
  {
    method: "POST",
    path: "/api/v1/recovery/guardians",
    paramNames: [],
    handler: addGuardianHandler,
  },
  {
    method: "DELETE",
    path: "/api/v1/recovery/guardians/g-1",
    paramNames: ["guardianId"],
    handler: removeGuardianHandler,
  },
  {
    method: "PATCH",
    path: "/api/v1/recovery/guardians/g-1/verify",
    paramNames: ["guardianId"],
    handler: verifyGuardianHandler,
  },
  {
    method: "POST",
    path: "/api/v1/recovery/emergency-contacts",
    paramNames: [],
    handler: addEmergencyContactHandler,
  },
  {
    method: "DELETE",
    path: "/api/v1/recovery/emergency-contacts/c-1",
    paramNames: ["contactId"],
    handler: removeEmergencyContactHandler,
  },
  {
    method: "POST",
    path: "/api/v1/recovery/user-123/initiate",
    paramNames: ["accountId"],
    handler: initiateRecoveryHandler,
  },
  {
    method: "POST",
    path: "/api/v1/recovery/rec-1/approve",
    paramNames: ["recoveryId"],
    handler: processGuardianApprovalHandler,
  },
  {
    method: "POST",
    path: "/api/v1/recovery/rec-1/reject",
    paramNames: ["recoveryId"],
    handler: rejectRecoveryHandler,
  },
  {
    method: "POST",
    path: "/api/v1/recovery/rec-1/cancel",
    paramNames: ["recoveryId"],
    handler: cancelRecoveryHandler,
  },
  {
    method: "POST",
    path: "/api/v1/recovery/rec-1/complete",
    paramNames: ["recoveryId"],
    handler: completeRecoveryHandler,
  },
  {
    method: "GET",
    path: "/api/v1/recovery/user-123/requests",
    paramNames: ["accountId"],
    handler: listRecoveryRequestsHandler,
  },
  {
    method: "GET",
    path: "/api/v1/recovery/user-123/progress",
    paramNames: ["accountId"],
    handler: getRecoveryProgressHandler,
  },
  {
    method: "GET",
    path: "/api/v1/recovery/user-123/verifiable",
    paramNames: ["accountId"],
    handler: isRecoverableHandler,
  },
];

function createRequest(url = "/api/v1/recovery/config", method = "GET"): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.url = url;
  req.method = method;
  req.headers = { host: "localhost" };
  return req;
}

function createResponse(): TestResponse {
  const headers: Record<string, unknown> = {};
  return {
    statusCode: 0,
    body: "",
    setHeader(name: string, value: unknown) {
      headers[name] = value;
    },
    getHeader(name: string) {
      return headers[name];
    },
    removeHeader(name: string) {
      delete headers[name];
    },
    writeHead(status: number) {
      this.statusCode = status;
    },
    end(chunk?: string) {
      if (chunk) this.body = chunk;
    },
  } as unknown as TestResponse;
}

function findRoute(method: string, path: string): Route {
  const registered = registerRecoveryRoutes().find(
    (candidate) => candidate.method === method && candidate.pattern.test(path),
  );
  if (!registered) throw new Error(`No route registered for ${method} ${path}`);
  return registered;
}

function responseBody(res: TestResponse): any {
  return JSON.parse(res.body);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthenticatedUserContext.mockReturnValue({
    userId: "user-123",
    email: "user@example.com",
    roles: [],
  });
});

describe("registerRecoveryRoutes", () => {
  it("registers every recovery endpoint with the expected method, pattern, params, and handler", () => {
    const routes = registerRecoveryRoutes();

    expect(routes).toHaveLength(expectedRoutes.length);
    expectedRoutes.forEach((expected, index) => {
      expect(routes[index].method).toBe(expected.method);
      expect(routes[index].pattern.test(expected.path)).toBe(true);
      expect(routes[index].paramNames).toEqual(expected.paramNames);
      expect(routes[index].handler).toBe(expected.handler);
    });
  });

  it("does not match malformed paths for parameterised routes", () => {
    const guardianRoute = findRoute("DELETE", "/api/v1/recovery/guardians/g-1");
    const initiateRoute = findRoute("POST", "/api/v1/recovery/user-123/initiate");

    expect(guardianRoute.pattern.test("/api/v1/recovery/guardians/g-1/extra")).toBe(false);
    expect(guardianRoute.pattern.test("/api/v1/recovery/guardians/")).toBe(false);
    expect(initiateRoute.pattern.test("/api/v1/recovery/initiate")).toBe(false);
  });
});

describe("registered recovery route handlers", () => {
  it("returns the authenticated user's recovery configuration on the happy path", async () => {
    const config = { accountId: "user-123", threshold: 2, guardians: [] };
    mocks.getRecoveryConfig.mockResolvedValue(config);

    const res = createResponse();
    await findRoute("GET", "/api/v1/recovery/config").handler(createRequest(), res, {});

    expect(mocks.getRecoveryConfig).toHaveBeenCalledWith("user-123");
    expect(res.statusCode).toBe(200);
    expect(responseBody(res).data).toEqual(config);
  });

  it("forwards the recovery id and request body for guardian approval", async () => {
    const body = { approved: true, signature: "sig" };
    const recovery = { id: "rec-1", status: "approved" };
    mocks.readJsonBody.mockResolvedValue(body);
    mocks.processGuardianApproval.mockResolvedValue(recovery);

    const res = createResponse();
    await findRoute("POST", "/api/v1/recovery/rec-1/approve").handler(
      createRequest("/api/v1/recovery/rec-1/approve", "POST"),
      res,
      { recoveryId: "rec-1" },
    );

    expect(mocks.processGuardianApproval).toHaveBeenCalledWith("rec-1", "user-123", body);
    expect(res.statusCode).toBe(200);
    expect(responseBody(res).data).toEqual(recovery);
  });

  it("rejects a configuration payload with insufficient guardian weight", async () => {
    mocks.readJsonBody.mockResolvedValue({
      threshold: 3,
      guardians: [{ id: "g-1", weight: 1 }],
    });

    const res = createResponse();
    await findRoute("POST", "/api/v1/recovery/config").handler(
      createRequest("/api/v1/recovery/config", "POST"),
      res,
      {},
    );

    expect(res.statusCode).toBe(400);
    expect(responseBody(res).error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Total guardian weight must meet or exceed threshold",
    });
    expect(mocks.createRecoveryConfig).not.toHaveBeenCalled();
  });

  it("returns 500 when the recovery service fails upstream", async () => {
    mocks.getRecoveryConfig.mockRejectedValue(new Error("recovery database unavailable"));

    const res = createResponse();
    await findRoute("GET", "/api/v1/recovery/config").handler(createRequest(), res, {});

    expect(res.statusCode).toBe(500);
    expect(responseBody(res).error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "recovery database unavailable",
    });
  });
});

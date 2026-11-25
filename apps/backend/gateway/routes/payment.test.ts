import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Route } from "@delegolabs/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserContext: vi.fn(),
  readJsonBody: vi.fn(),
  tokenizeCard: vi.fn(),
  tokenizeBankAccount: vi.fn(),
  tokenizeWallet: vi.fn(),
  verifyPaymentMethod: vi.fn(),
  listPaymentMethods: vi.fn(),
  updatePaymentMethod: vi.fn(),
  removePaymentMethod: vi.fn(),
  getPaymentMethod: vi.fn(),
  markPaymentMethodUsed: vi.fn(),
  isUsable: vi.fn(),
}));

vi.mock("../middleware/auth.js", () => ({
  getAuthenticatedUserContext: mocks.getAuthenticatedUserContext,
}));

vi.mock("../src/request.js", () => ({
  readJsonBody: mocks.readJsonBody,
}));

vi.mock("../src/payment/service.js", () => ({
  tokenizeCard: mocks.tokenizeCard,
  tokenizeBankAccount: mocks.tokenizeBankAccount,
  tokenizeWallet: mocks.tokenizeWallet,
  verifyPaymentMethod: mocks.verifyPaymentMethod,
  listPaymentMethods: mocks.listPaymentMethods,
  updatePaymentMethod: mocks.updatePaymentMethod,
  removePaymentMethod: mocks.removePaymentMethod,
  getPaymentMethod: mocks.getPaymentMethod,
  markPaymentMethodUsed: mocks.markPaymentMethodUsed,
  isUsable: mocks.isUsable,
}));

import { registerPaymentRoutes } from "./payment.js";
import {
  createCardPaymentMethodHandler,
  createBankAccountPaymentMethodHandler,
  createWalletPaymentMethodHandler,
  verifyPaymentMethodHandler,
  listPaymentMethodsHandler,
  getPaymentMethodHandler,
  updatePaymentMethodHandler,
  removePaymentMethodHandler,
  markPaymentMethodUsedHandler,
  checkPaymentMethodUsableHandler,
} from "../src/payment/routes.js";

type TestResponse = ServerResponse & { body: string };

const expectedRoutes: Array<{
  method: string;
  path: string;
  paramNames: string[];
  handler: Route["handler"];
}> = [
  {
    method: "POST",
    path: "/api/v1/payment-methods/card",
    paramNames: [],
    handler: createCardPaymentMethodHandler,
  },
  {
    method: "POST",
    path: "/api/v1/payment-methods/bank-account",
    paramNames: [],
    handler: createBankAccountPaymentMethodHandler,
  },
  {
    method: "POST",
    path: "/api/v1/payment-methods/wallet",
    paramNames: [],
    handler: createWalletPaymentMethodHandler,
  },
  {
    method: "GET",
    path: "/api/v1/payment-methods",
    paramNames: [],
    handler: listPaymentMethodsHandler,
  },
  {
    method: "GET",
    path: "/api/v1/payment-methods/pm-1",
    paramNames: ["paymentMethodId"],
    handler: getPaymentMethodHandler,
  },
  {
    method: "POST",
    path: "/api/v1/payment-methods/pm-1/verify",
    paramNames: ["paymentMethodId"],
    handler: verifyPaymentMethodHandler,
  },
  {
    method: "PATCH",
    path: "/api/v1/payment-methods/pm-1",
    paramNames: ["paymentMethodId"],
    handler: updatePaymentMethodHandler,
  },
  {
    method: "DELETE",
    path: "/api/v1/payment-methods/pm-1",
    paramNames: ["paymentMethodId"],
    handler: removePaymentMethodHandler,
  },
  {
    method: "POST",
    path: "/api/v1/payment-methods/pm-1/used",
    paramNames: ["paymentMethodId"],
    handler: markPaymentMethodUsedHandler,
  },
  {
    method: "GET",
    path: "/api/v1/payment-methods/pm-1/usable",
    paramNames: ["paymentMethodId"],
    handler: checkPaymentMethodUsableHandler,
  },
];

function createRequest(
  url = "/api/v1/payment-methods",
  method = "GET",
): IncomingMessage {
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
  const registered = registerPaymentRoutes().find(
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

describe("registerPaymentRoutes", () => {
  it("registers every payment method endpoint with the expected method, pattern, params, and handler", () => {
    const routes = registerPaymentRoutes();

    expect(routes).toHaveLength(expectedRoutes.length);
    expectedRoutes.forEach((expected, index) => {
      expect(routes[index].method).toBe(expected.method);
      expect(routes[index].pattern.test(expected.path)).toBe(true);
      expect(routes[index].paramNames).toEqual(expected.paramNames);
      expect(routes[index].handler).toBe(expected.handler);
    });
  });

  it("does not match malformed paths for parameterised routes", () => {
    const paymentMethodRoute = findRoute("GET", "/api/v1/payment-methods/pm-1");
    const usableRoute = findRoute("GET", "/api/v1/payment-methods/pm-1/usable");

    expect(paymentMethodRoute.pattern.test("/api/v1/payment-methods/pm-1/usable")).toBe(false);
    expect(paymentMethodRoute.pattern.test("/api/v1/payment-methods/")).toBe(false);
    expect(usableRoute.pattern.test("/api/v1/payment-methods/usable")).toBe(false);
  });
});

describe("registered payment route handlers", () => {
  it("tokenizes a card and returns the vault result on the happy path", async () => {
    const body = {
      customerId: "user-123",
      details: {
        number: "4242424242424242",
        expMonth: 12,
        expYear: 2030,
        cvc: "123",
      },
    };
    const tokenized = { paymentMethodId: "pm-1", vaultToken: "vlt_1" };
    mocks.readJsonBody.mockResolvedValue(body);
    mocks.tokenizeCard.mockResolvedValue(tokenized);

    const res = createResponse();
    await findRoute("POST", "/api/v1/payment-methods/card").handler(
      createRequest("/api/v1/payment-methods/card", "POST"),
      res,
      {},
    );

    expect(mocks.tokenizeCard).toHaveBeenCalledWith({ ...body, type: "card" });
    expect(res.statusCode).toBe(200);
    expect(responseBody(res).data).toEqual(tokenized);
  });

  it("forwards list filters from the query string to the payment service", async () => {
    const result = { methods: [], total: 0 };
    mocks.listPaymentMethods.mockResolvedValue(result);

    const res = createResponse();
    await findRoute("GET", "/api/v1/payment-methods").handler(
      createRequest("/api/v1/payment-methods?status=active&page=2&limit=5"),
      res,
      {},
    );

    expect(mocks.listPaymentMethods).toHaveBeenCalledWith({
      customerId: "user-123",
      status: "active",
      type: undefined,
      page: 2,
      limit: 5,
    });
    expect(res.statusCode).toBe(200);
    expect(responseBody(res).data).toEqual(result);
  });

  it("rejects a payload whose customer id does not match the authenticated user", async () => {
    mocks.readJsonBody.mockResolvedValue({
      customerId: "another-user",
      details: {
        number: "4242424242424242",
        expMonth: 12,
        expYear: 2030,
        cvc: "123",
      },
    });

    const res = createResponse();
    await findRoute("POST", "/api/v1/payment-methods/card").handler(
      createRequest("/api/v1/payment-methods/card", "POST"),
      res,
      {},
    );

    expect(res.statusCode).toBe(404);
    expect(responseBody(res).error).toMatchObject({
      code: "NOT_FOUND",
      message: "Customer ID does not match authenticated user",
    });
    expect(mocks.tokenizeCard).not.toHaveBeenCalled();
  });

  it("returns 500 when the payment vault fails upstream", async () => {
    mocks.readJsonBody.mockResolvedValue({
      customerId: "user-123",
      details: {
        number: "4242424242424242",
        expMonth: 12,
        expYear: 2030,
        cvc: "123",
      },
    });
    mocks.tokenizeCard.mockRejectedValue(new Error("vault provider timeout"));

    const res = createResponse();
    await findRoute("POST", "/api/v1/payment-methods/card").handler(
      createRequest("/api/v1/payment-methods/card", "POST"),
      res,
      {},
    );

    expect(res.statusCode).toBe(500);
    expect(responseBody(res).error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "vault provider timeout",
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@delegolabs/utils", () => ({
  route: (method: string, path: string, handler: unknown) => ({ method, path, handler }),
}));

vi.mock("../src/multi-currency/routes.js", () => {
  const h = () => vi.fn();
  return {
    getFXRateHandler: h(),
    findConversionPathHandler: h(),
    createMultiCurrencyPaymentHandler: h(),
    executePathPaymentHandler: h(),
    completeMultiCurrencyPaymentHandler: h(),
    failMultiCurrencyPaymentHandler: h(),
    getPaymentHandler: h(),
    listPaymentsHandler: h(),
    getAutoRouteHandler: h(),
    refreshFXRatesHandler: h(),
    calculateAccountExposureHandler: h(),
  };
});

import { registerMultiCurrencyRoutes } from "./multi-currency.js";
import * as handlers from "../src/multi-currency/routes.js";

describe("multi-currency routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers all multi-currency routes", () => {
    const routes = registerMultiCurrencyRoutes();
    expect(routes).toHaveLength(12);
  });

  it("maps FX endpoints to their handlers", () => {
    const routes = registerMultiCurrencyRoutes();
    const find = (method: string, path: string) =>
      routes.find((r) => r.method === method && r.path === path);

    expect(find("GET", "/api/v1/fx/rate")?.handler).toBe(handlers.getFXRateHandler);
    expect(find("GET", "/api/v1/fx/path")?.handler).toBe(handlers.findConversionPathHandler);
    expect(find("POST", "/api/v1/fx/refresh")?.handler).toBe(handlers.refreshFXRatesHandler);
  });

  it("maps payment endpoints to their handlers", () => {
    const routes = registerMultiCurrencyRoutes();
    const find = (method: string, path: string) =>
      routes.find((r) => r.method === method && r.path === path);

    expect(find("POST", "/api/v1/payments/multi-currency")?.handler)
      .toBe(handlers.createMultiCurrencyPaymentHandler);
    expect(find("POST", "/api/v1/payments/multi-currency/:paymentId/execute")?.handler)
      .toBe(handlers.executePathPaymentHandler);
    expect(find("POST", "/api/v1/payments/multi-currency/:paymentId/complete")?.handler)
      .toBe(handlers.completeMultiCurrencyPaymentHandler);
    expect(find("POST", "/api/v1/payments/multi-currency/:paymentId/fail")?.handler)
      .toBe(handlers.failMultiCurrencyPaymentHandler);
    expect(find("GET", "/api/v1/payments/multi-currency/:paymentId")?.handler)
      .toBe(handlers.getPaymentHandler);
    expect(find("GET", "/api/v1/payments/multi-currency")?.handler)
      .toBe(handlers.listPaymentsHandler);
  });

  it("maps route and exposure endpoints to their handlers", () => {
    const routes = registerMultiCurrencyRoutes();
    const find = (method: string, path: string) =>
      routes.find((r) => r.method === method && r.path === path);

    expect(find("GET", "/api/v1/payments/multi-currency/route")?.handler)
      .toBe(handlers.getAutoRouteHandler);
    expect(find("GET", "/api/v1/exposure/:accountId")?.handler)
      .toBe(handlers.calculateAccountExposureHandler);
  });

  it("uses only the documented HTTP methods", () => {
    const routes = registerMultiCurrencyRoutes();
    const methods = new Set(routes.map((r) => r.method));
    expect([...methods].sort()).toEqual(["GET", "POST"]);
  });
});

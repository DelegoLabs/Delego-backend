import type { Route } from "@delegolabs/utils";
import { route } from "@delegolabs/utils";
import {
  getFXRateHandler,
  findConversionPathHandler,
  createMultiCurrencyPaymentHandler,
  executePathPaymentHandler,
  completeMultiCurrencyPaymentHandler,
  failMultiCurrencyPaymentHandler,
  getPaymentHandler,
  listPaymentsHandler,
  getAutoRouteHandler,
  refreshFXRatesHandler,
  calculateAccountExposureHandler,
} from "../src/multi-currency/routes.js";

/**
 * Register multi-currency routes
 */
export function registerMultiCurrencyRoutes(): Route[] {
  return [
    // FX Rate endpoints
    route("GET", "/api/v1/fx/rate", getFXRateHandler),
    route("GET", "/api/v1/fx/path", findConversionPathHandler),
    route("POST", "/api/v1/fx/refresh", refreshFXRatesHandler), // Admin only

    // Multi-currency payment endpoints
    route("POST", "/api/v1/payments/multi-currency", createMultiCurrencyPaymentHandler),
    route("POST", "/api/v1/payments/multi-currency/:paymentId/execute", executePathPaymentHandler),
    route("POST", "/api/v1/payments/multi-currency/:paymentId/complete", completeMultiCurrencyPaymentHandler),
    route("POST", "/api/v1/payments/multi-currency/:paymentId/fail", failMultiCurrencyPaymentHandler),
    route("GET", "/api/v1/payments/multi-currency/:paymentId", getPaymentHandler),
    route("GET", "/api/v1/payments/multi-currency", listPaymentsHandler),

    // Route and exposure endpoints
    route("GET", "/api/v1/payments/multi-currency/route", getAutoRouteHandler),
    route("GET", "/api/v1/exposure/:accountId", calculateAccountExposureHandler),
  ];
}

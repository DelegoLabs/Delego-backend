import type { Route } from "@delegolabs/utils";
import { route } from "@delegolabs/utils";
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

/**
 * Register payment method vault routes
 */
export function registerPaymentRoutes(): Route[] {
  return [
    // Create payment methods
    route("POST", "/api/v1/payment-methods/card", createCardPaymentMethodHandler),
    route("POST", "/api/v1/payment-methods/bank-account", createBankAccountPaymentMethodHandler),
    route("POST", "/api/v1/payment-methods/wallet", createWalletPaymentMethodHandler),
    // List payment methods for a customer
    route("GET", "/api/v1/payment-methods", listPaymentMethodsHandler),
    // Get payment method by ID
    route("GET", "/api/v1/payment-methods/:paymentMethodId", getPaymentMethodHandler),
    // Verify payment method
    route("POST", "/api/v1/payment-methods/:paymentMethodId/verify", verifyPaymentMethodHandler),
    // Update payment method
    route("PATCH", "/api/v1/payment-methods/:paymentMethodId", updatePaymentMethodHandler),
    // Remove payment method
    route("DELETE", "/api/v1/payment-methods/:paymentMethodId", removePaymentMethodHandler),
    // Mark payment method as used
    route("POST", "/api/v1/payment-methods/:paymentMethodId/used", markPaymentMethodUsedHandler),
    // Check if payment method is usable
    route("GET", "/api/v1/payment-methods/:paymentMethodId/usable", checkPaymentMethodUsableHandler),
  ];
}

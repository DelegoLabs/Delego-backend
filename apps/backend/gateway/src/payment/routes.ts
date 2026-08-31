import type { RouteHandler } from "@delegolabs/utils";
import { json } from "@delegolabs/utils";
import { internalError, notFound, validationError, success } from "../errors.js";
import { getAuthenticatedUserContext } from "../middleware/auth.js";
import {
  tokenizeCard,
  tokenizeBankAccount,
  tokenizeWallet,
  verifyPaymentMethod,
  listPaymentMethods,
  updatePaymentMethod,
  removePaymentMethod,
  getPaymentMethod,
  markPaymentMethodUsed,
  isUsable,
} from "./service.js";
import type {
  PaymentMethodCreate,
  VerificationRequest,
  VaultListMethodsRequest,
  VaultUpdateMethodRequest,
  VaultRemoveMethodRequest,
  ThreeDSecureRequest,
  ThreeDSecureResult,
} from "@delegolabs/types";

/**
 * Create card payment method handler
 */
export const createCardPaymentMethodHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const body: PaymentMethodCreate = req.body;

    // Verify customer ID matches authenticated user
    if (body.customerId !== userContext.userId) {
      return notFound(res, "Customer ID does not match authenticated user", req);
    }

    const result = await tokenizeCard({
      ...body,
      type: "card",
    });

    return success(res, result, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Create bank account payment method handler
 */
export const createBankAccountPaymentMethodHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const body: PaymentMethodCreate = req.body;

    // Verify customer ID matches authenticated user
    if (body.customerId !== userContext.userId) {
      return notFound(res, "Customer ID does not match authenticated user", req);
    }

    const result = await tokenizeBankAccount({
      ...body,
      type: "bank_account",
    });

    return success(res, result, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Create wallet payment method handler
 */
export const createWalletPaymentMethodHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const body: PaymentMethodCreate = req.body;

    // Verify customer ID matches authenticated user
    if (body.customerId !== userContext.userId) {
      return notFound(res, "Customer ID does not match authenticated user", req);
    }

    const result = await tokenizeWallet({
      ...body,
      type: "wallet",
    });

    return success(res, result, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Verify payment method handler
 */
export const verifyPaymentMethodHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { paymentMethodId } = req.params as { paymentMethodId: string };
    const body: VerificationRequest = req.body;

    // Verify customer owns this payment method
    const userPaymentMethod = await getPaymentMethod(paymentMethodId);
    if (!userPaymentMethod || userPaymentMethod.customerId !== userContext.userId) {
      return notFound(res, "Payment method not found or access denied", req);
    }

    const result = await verifyPaymentMethod(
      paymentMethodId,
      body.method,
      body
    );

    return success(res, result, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * List payment methods handler
 */
export const listPaymentMethodsHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { customerId } = req.params as { customerId: string };

    // Verify customer ID matches authenticated user
    if (customerId !== userContext.userId) {
      return notFound(res, "Customer ID does not match authenticated user", req);
    }

    const query: VaultListMethodsRequest = {
      customerId,
      status: req.query?.status as any,
      type: req.query?.type as any,
      page: Number(req.query?.page) || 1,
      limit: Number(req.query?.limit) || 20,
    };

    const result = await listPaymentMethods(query);

    return success(res, result, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Get payment method by ID handler
 */
export const getPaymentMethodHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { paymentMethodId } = req.params as { paymentMethodId: string };

    const paymentMethod = await getPaymentMethod(paymentMethodId);
    if (!paymentMethod) {
      return notFound(res, "Payment method not found", req);
    }

    // Verify customer owns this payment method
    if (paymentMethod.customerId !== userContext.userId) {
      return notFound(res, "Payment method not found or access denied", req);
    }

    return success(res, paymentMethod, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Update payment method handler
 */
export const updatePaymentMethodHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { paymentMethodId } = req.params as { paymentMethodId: string };
    const body: VaultUpdateMethodRequest = req.body;

    // Verify customer owns this payment method
    const userPaymentMethod = await getPaymentMethod(paymentMethodId);
    if (!userPaymentMethod || userPaymentMethod.customerId !== userContext.userId) {
      return notFound(res, "Payment method not found or access denied", req);
    }

    await updatePaymentMethod(paymentMethodId, body);

    return success(res, { success: true }, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Remove payment method handler
 */
export const removePaymentMethodHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { paymentMethodId } = req.params as { paymentMethodId: string };
    const body: VaultRemoveMethodRequest = req.body;

    // Verify customer owns this payment method
    const userPaymentMethod = await getPaymentMethod(paymentMethodId);
    if (!userPaymentMethod || userPaymentMethod.customerId !== userContext.userId) {
      return notFound(res, "Payment method not found or access denied", req);
    }

    await removePaymentMethod(paymentMethodId, body);

    return success(res, { success: true }, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Mark payment method as used handler
 */
export const markPaymentMethodUsedHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { paymentMethodId } = req.params as { paymentMethodId: string };

    // Verify customer owns this payment method
    const userPaymentMethod = await getPaymentMethod(paymentMethodId);
    if (!userPaymentMethod || userPaymentMethod.customerId !== userContext.userId) {
      return notFound(res, "Payment method not found or access denied", req);
    }

    await markPaymentMethodUsed(paymentMethodId);

    return success(res, { success: true }, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Check if payment method is usable handler
 */
export const checkPaymentMethodUsableHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { paymentMethodId } = req.params as { paymentMethodId: string };

    // Verify customer owns this payment method
    const userPaymentMethod = await getPaymentMethod(paymentMethodId);
    if (!userPaymentMethod || userPaymentMethod.customerId !== userContext.userId) {
      return notFound(res, "Payment method not found or access denied", req);
    }

    const usable = isUsable(paymentMethodId);

    return success(res, { usable }, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

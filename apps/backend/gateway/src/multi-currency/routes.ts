import type { RouteHandler } from "@delegolabs/utils";
import { json } from "@delegolabs/utils";
import { internalError, notFound, validationError, success } from "../errors.js";
import { getAuthenticatedUserContext } from "../middleware/auth.js";
import {
  getFXRate,
  findConversionPath,
  refreshAllFXRates,
} from "./fxService.js";
import {
  createMultiCurrencyPayment,
  executePathPayment,
  completeMultiCurrencyPayment,
  failMultiCurrencyPayment,
  getPayment,
  listPayments,
  calculateAccountExposure,
  getAutoRoute,
} from "./paymentService.js";
import type {
  FXRateRequest,
  FXRateResponse,
  MultiCurrencyPaymentRequest,
  MultiCurrencyPaymentResponse,
  AutoRouteRequest,
  AutoRouteResponse,
} from "@delegolabs/types";

/**
 * Get FX rate handler
 */
export const getFXRateHandler: RouteHandler = async (req, res) => {
  try {
    const { baseCurrency, quoteCurrency } = req.query as { baseCurrency: string; quoteCurrency: string };

    if (!baseCurrency || !quoteCurrency) {
      return validationError(res, "baseCurrency and quoteCurrency are required", req);
    }

    const rate = await getFXRate({ baseCurrency, quoteCurrency });

    return success(res, rate, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Find conversion path handler
 */
export const findConversionPathHandler: RouteHandler = async (req, res) => {
  try {
    const { fromCurrency, toCurrency } = req.query as { fromCurrency: string; toCurrency: string };

    if (!fromCurrency || !toCurrency) {
      return validationError(res, "fromCurrency and toCurrency are required", req);
    }

    const result = await findConversionPath(fromCurrency, toCurrency);

    return success(res, result, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Create multi-currency payment handler
 */
export const createMultiCurrencyPaymentHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const body: MultiCurrencyPaymentRequest = req.body;

    // Validate required fields
    if (!body.sourceCurrency || !body.sourceAmount || !body.destinationCurrency || !body.destinationAddress) {
      return validationError(
        res,
        "sourceCurrency, sourceAmount, destinationCurrency, and destinationAddress are required",
        req
      );
    }

    // Add user wallet address if not provided
    if (!body.metadata?.sourceAddress) {
      body.metadata = { ...body.metadata, sourceAddress: userContext.userId };
    }

    const payment = await createMultiCurrencyPayment(body);

    return success(res, payment, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Execute path payment handler
 */
export const executePathPaymentHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { paymentId } = req.params as { paymentId: string };
    const { transactionHash } = req.body as { transactionHash: string };

    const payment = await executePathPayment(paymentId, transactionHash);

    return success(res, payment, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Complete multi-currency payment handler
 */
export const completeMultiCurrencyPaymentHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { paymentId } = req.params as { paymentId: string };
    const { ledgerSequence } = req.body as { ledgerSequence: number };

    const payment = await completeMultiCurrencyPayment(paymentId, ledgerSequence);

    return success(res, payment, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Fail multi-currency payment handler
 */
export const failMultiCurrencyPaymentHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { paymentId } = req.params as { paymentId: string };
    const { reason } = req.body as { reason: string };

    const payment = await failMultiCurrencyPayment(paymentId, reason);

    return success(res, payment, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Get payment handler
 */
export const getPaymentHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { paymentId } = req.params as { paymentId: string };

    const payment = await getPayment(paymentId);
    if (!payment) {
      return notFound(res, "Payment not found", req);
    }

    return success(res, payment, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * List payments handler
 */
export const listPaymentsHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const filters: any = {
      sourceCurrency: req.query?.sourceCurrency,
      destinationCurrency: req.query?.destinationCurrency,
      status: req.query?.status,
      page: Number(req.query?.page) || 1,
      limit: Number(req.query?.limit) || 20,
    };

    const result = await listPayments(filters);

    return success(res, result, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Get auto-route handler
 */
export const getAutoRouteHandler: RouteHandler = async (req, res) => {
  try {
    const { sourceCurrency, sourceAmount, destinationCurrency } = req.query as {
      sourceCurrency: string;
      sourceAmount: string;
      destinationCurrency: string;
    };

    if (!sourceCurrency || !sourceAmount || !destinationCurrency) {
      return validationError(
        res,
        "sourceCurrency, sourceAmount, and destinationCurrency are required",
        req
      );
    }

    const route = await getAutoRoute(sourceCurrency, sourceAmount, destinationCurrency);

    return success(res, route, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Refresh FX rates handler
 */
export const refreshFXRatesHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    // Only admins can refresh FX rates
    if (!userContext.roles?.includes("admin")) {
      return notFound(res, "Insufficient permissions", req);
    }

    await refreshAllFXRates();

    return success(res, { success: true, message: "FX rates refreshed" }, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Calculate account exposure handler
 */
export const calculateAccountExposureHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { accountId } = req.params as { accountId: string };

    if (accountId !== userContext.userId && !userContext.roles?.includes("admin")) {
      return notFound(res, "Cannot view exposure for another account", req);
    }

    const exposures = await calculateAccountExposure(accountId);

    return success(res, exposures, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

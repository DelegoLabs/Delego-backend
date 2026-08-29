import type { IncomingMessage } from "node:http";
import { getPaymentMethod } from "./service.js";
import { notFound, forbidden } from "../errors.js";

/**
 * Interface for payment method ownership context
 */
export interface PaymentMethodContext {
  paymentMethodId: string;
  customerId: string;
}

/**
 * Check if the authenticated user owns this payment method
 */
export async function verifyPaymentMethodOwnership(
  req: IncomingMessage,
  res: any,
  next: (err?: unknown) => void
): Promise<void> {
  try {
    const userContext = (req as any).userContext;
    if (!userContext) {
      return forbidden(res, "User not authenticated", req);
    }

    const paymentMethodId = (req as any).params?.paymentMethodId;
    if (!paymentMethodId) {
      return notFound(res, "Payment method ID not provided", req);
    }

    const paymentMethod = await getPaymentMethod(paymentMethodId);
    if (!paymentMethod) {
      return notFound(res, "Payment method not found", req);
    }

    // Verify customer owns this payment method
    if (paymentMethod.customerId !== userContext.userId) {
      return forbidden(res, "Payment method not found or access denied", req);
    }

    // Add payment method context to request
    (req as any).paymentMethodContext = {
      paymentMethodId: paymentMethod.id,
      customerId: paymentMethod.customerId,
    };

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware to check if payment method is active
 */
export async function ensurePaymentMethodActive(
  req: IncomingMessage,
  res: any,
  next: (err?: unknown) => void
): Promise<void> {
  try {
    const paymentMethodContext = (req as any).paymentMethodContext;
    if (!paymentMethodContext) {
      return notFound(res, "Payment method context not found", req);
    }

    const { paymentMethodId } = paymentMethodContext;
    const paymentMethod = await getPaymentMethod(paymentMethodId);
    if (!paymentMethod) {
      return notFound(res, "Payment method not found", req);
    }

    if (paymentMethod.status !== "active") {
      return forbidden(res, `Payment method is ${paymentMethod.status}`, req);
    }

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware to check if payment method is verified
 */
export async function ensurePaymentMethodVerified(
  req: IncomingMessage,
  res: any,
  next: (err?: unknown) => void
): Promise<void> {
  try {
    const paymentMethodContext = (req as any).paymentMethodContext;
    if (!paymentMethodContext) {
      return notFound(res, "Payment method context not found", req);
    }

    const { paymentMethodId } = paymentMethodContext;
    const paymentMethod = await getPaymentMethod(paymentMethodId);
    if (!paymentMethod) {
      return notFound(res, "Payment method not found", req);
    }

    if (!paymentMethod.verified) {
      return forbidden(res, "Payment method is not verified", req);
    }

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware to check if payment method has 3D Secure enabled
 */
export async function ensureThreeDSecureEnabled(
  req: IncomingMessage,
  res: any,
  next: (err?: unknown) => void
): Promise<void> {
  try {
    const paymentMethodContext = (req as any).paymentMethodContext;
    if (!paymentMethodContext) {
      return notFound(res, "Payment method context not found", req);
    }

    const { paymentMethodId } = paymentMethodContext;
    const paymentMethod = await getPaymentMethod(paymentMethodId);
    if (!paymentMethod) {
      return notFound(res, "Payment method not found", req);
    }

    if (!paymentMethod.threeDSecureEnabled) {
      return forbidden(res, "3D Secure is not enabled for this payment method", req);
    }

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware to check if payment method is expired
 */
export async function ensurePaymentMethodNotExpired(
  req: IncomingMessage,
  res: any,
  next: (err?: unknown) => void
): Promise<void> {
  try {
    const paymentMethodContext = (req as any).paymentMethodContext;
    if (!paymentMethodContext) {
      return notFound(res, "Payment method context not found", req);
    }

    const { paymentMethodId } = paymentMethodContext;
    const paymentMethod = await getPaymentMethod(paymentMethodId);
    if (!paymentMethod) {
      return notFound(res, "Payment method not found", req);
    }

    const now = new Date();
    if (paymentMethod.expiryYear !== undefined && paymentMethod.expiryMonth !== undefined) {
      const expiryDate = new Date(paymentMethod.expiryYear, paymentMethod.expiryMonth, 1);
      expiryDate.setMonth(expiryDate.getMonth() + 1); // End of month

      if (expiryDate < now) {
        return forbidden(res, "Payment method has expired", req);
      }
    }

    next();
  } catch (err) {
    next(err);
  }
}

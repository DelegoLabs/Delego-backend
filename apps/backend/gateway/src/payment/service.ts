import { PaymentMethod, isPaymentMethodExpired, isPaymentMethodUsable } from "../models/PaymentMethod.js";
import { PaymentAuditLog } from "../models/PaymentAuditLog.js";
import { User } from "../models/User.js";
import { generateFingerprint, validateCardDetails, validateBankDetails, validateWalletDetails } from "./validator.js";
import type { 
  PaymentMethod as PaymentMethodType,
  PaymentMethodCreate,
  TokenizationResponse,
  VerificationResult,
  VerificationRequest,
  VaultListMethodsRequest,
  VaultListMethodsResponse,
  VaultUpdateMethodRequest,
  VaultRemoveMethodRequest,
  ThreeDSecureRequest,
  ThreeDSecureResult,
  NetworkTokenizationRequest,
  NetworkTokenizationResponse,
} from "@delegolabs/types";

const crypto = await import("crypto");

/**
 * Generate a unique vault token for payment method
 */
export function generateVaultToken(): string {
  return `pm_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Tokenize a card payment method
 */
export async function tokenizeCard(
  request: PaymentMethodCreate
): Promise<TokenizationResponse> {
  // Validate card details
  const validation = validateCardDetails({
    number: request.details.number,
    expMonth: request.details.expMonth,
    expYear: request.details.expYear,
    cvc: request.details.cvc,
  });

  if (!validation.valid) {
    throw new Error(`Card validation failed: ${validation.errors.join(", ")}`);
  }

  const customerId = request.customerId;

  // Check if customer exists
  const customer = await User.findOne({ where: { id: customerId } });
  if (!customer) {
    throw new Error("Customer not found");
  }

  // Generate vault token
  const vaultToken = generateVaultToken();

  // Generate fingerprint
  const fingerprint = generateFingerprint(
    "card",
    {
      last4: request.details.number?.slice(-4),
      expiryMonth: request.details.expMonth,
      expiryYear: request.details.expYear,
    },
    customerId
  );

  // Determine card brand
  const cardNumber = request.details.number || "";
  let brand: string | undefined;
  if (cardNumber.startsWith("4")) {
    brand = "visa";
  } else if (cardNumber.startsWith("5")) {
    brand = "mastercard";
  } else if (cardNumber.startsWith("34") || cardNumber.startsWith("37")) {
    brand = "amex";
  } else if (cardNumber.startsWith("6")) {
    brand = "discover";
  }

  // Create payment method record
  const paymentMethod = await PaymentMethod.create({
    customerId,
    type: "card",
    token: vaultToken,
    brand,
    last4: cardNumber.slice(-4),
    expiryMonth: request.details.expMonth,
    expiryYear: request.details.expYear,
    fingerprint,
    verified: false,
    verificationMethod: "none",
    metadata: request.metadata || {},
    status: "active",
    threeDSecureEnabled: request.threeDSecure?.enabled ?? false,
  });

  // Log creation event
  await PaymentAuditLog.create({
    eventId: crypto.randomUUID(),
    eventType: "payment_method_created",
    actorId: customerId,
    actorType: "user",
    resourceId: paymentMethod.id,
    resourceType: "payment_method",
    details: {
      type: "card",
      brand,
      last4: paymentMethod.last4,
      verificationMethod: "none",
    },
  });

  // Handle verification if requested
  let verificationResult: VerificationResult | null = null;
  if (request.verification) {
    verificationResult = await initiateVerification({
      paymentMethodId: paymentMethod.id,
      method: request.verification.method,
      returnUrl: request.verification.returnUrl,
    });
  }

  return {
    paymentMethodId: paymentMethod.id,
    token: paymentMethod.token,
    fingerprint: paymentMethod.fingerprint,
    last4: paymentMethod.last4,
    expiryMonth: paymentMethod.expiryMonth,
    expiryYear: paymentMethod.expiryYear,
    brand: paymentMethod.brand,
    verified: paymentMethod.verified,
    verificationRequired: verificationResult ? verificationResult.status === "pending" : false,
    verificationMethod: verificationResult?.status === "pending" ? verificationResult.verificationDetails.method : undefined,
  };
}

/**
 * Tokenize a bank account payment method
 */
export async function tokenizeBankAccount(
  request: PaymentMethodCreate
): Promise<TokenizationResponse> {
  // Validate bank details
  const validation = validateBankDetails({
    accountNumber: request.details.accountNumber,
    routingNumber: request.details.routingNumber,
    accountType: request.details.accountType,
  });

  if (!validation.valid) {
    throw new Error(`Bank account validation failed: ${validation.errors.join(", ")}`);
  }

  const customerId = request.customerId;

  // Check if customer exists
  const customer = await User.findOne({ where: { id: customerId } });
  if (!customer) {
    throw new Error("Customer not found");
  }

  // Generate vault token
  const vaultToken = generateVaultToken();

  // Generate fingerprint
  const fingerprint = generateFingerprint(
    "bank_account",
    {
      last4: request.details.accountNumber?.slice(-4),
      accountType: request.details.accountType,
    },
    customerId
  );

  // Create payment method record
  const paymentMethod = await PaymentMethod.create({
    customerId,
    type: "bank_account",
    token: vaultToken,
    fingerprint,
    verified: false,
    verificationMethod: "none",
    metadata: request.metadata || {},
    status: "active",
    threeDSecureEnabled: false,
  });

  // Log creation event
  await PaymentAuditLog.create({
    eventId: crypto.randomUUID(),
    eventType: "payment_method_created",
    actorId: customerId,
    actorType: "user",
    resourceId: paymentMethod.id,
    resourceType: "payment_method",
    details: {
      type: "bank_account",
      accountType: paymentMethod.metadata?.accountType,
      verificationMethod: "none",
    },
  });

  // Handle verification if requested
  let verificationResult: VerificationResult | null = null;
  if (request.verification) {
    verificationResult = await initiateVerification({
      paymentMethodId: paymentMethod.id,
      method: request.verification.method,
      returnUrl: request.verification.returnUrl,
    });
  }

  return {
    paymentMethodId: paymentMethod.id,
    token: paymentMethod.token,
    fingerprint: paymentMethod.fingerprint,
    verified: paymentMethod.verified,
    verificationRequired: verificationResult ? verificationResult.status === "pending" : false,
    verificationMethod: verificationResult?.status === "pending" ? verificationResult.verificationDetails.method : undefined,
  };
}

/**
 * Tokenize a wallet payment method
 */
export async function tokenizeWallet(
  request: PaymentMethodCreate
): Promise<TokenizationResponse> {
  // Validate wallet details
  const validation = validateWalletDetails({
    walletType: request.details.walletType,
    walletToken: request.details.walletToken,
    walletAddress: request.details.walletAddress,
  });

  if (!validation.valid) {
    throw new Error(`Wallet validation failed: ${validation.errors.join(", ")}`);
  }

  const customerId = request.customerId;

  // Check if customer exists
  const customer = await User.findOne({ where: { id: customerId } });
  if (!customer) {
    throw new Error("Customer not found");
  }

  // Generate vault token
  const vaultToken = generateVaultToken();

  // Generate fingerprint
  const fingerprint = generateFingerprint(
    "wallet",
    {
      walletType: request.details.walletType,
      walletAddress: request.details.walletAddress,
    },
    customerId
  );

  // Create payment method record
  const paymentMethod = await PaymentMethod.create({
    customerId,
    type: "wallet" as const,
    token: vaultToken,
    fingerprint,
    verified: true,
    verificationMethod: "instant",
    metadata: {
      ...(request.metadata || {}),
      walletType: request.details.walletType,
      walletAddress: request.details.walletAddress,
    },
    status: "active",
    threeDSecureEnabled: false,
  });

  // Log creation event
  await PaymentAuditLog.create({
    eventId: crypto.randomUUID(),
    eventType: "payment_method_created",
    actorId: customerId,
    actorType: "user",
    resourceId: paymentMethod.id,
    resourceType: "payment_method",
    details: {
      type: "wallet",
      walletType: paymentMethod.metadata?.walletType,
      walletAddress: paymentMethod.metadata?.walletAddress,
      verified: true,
      verificationMethod: "instant",
    },
  });

  return {
    paymentMethodId: paymentMethod.id,
    token: paymentMethod.token,
    fingerprint: paymentMethod.fingerprint,
    verified: paymentMethod.verified,
    verificationMethod: paymentMethod.verificationMethod,
  };
}

/**
 * Verify a payment method
 */
export async function verifyPaymentMethod(
  paymentMethodId: string,
  method: "3ds" | "microdeposit" | "instant",
  details?: Record<string, unknown>
): Promise<VerificationResult> {
  const paymentMethod = await PaymentMethod.findByPk(paymentMethodId);
  if (!paymentMethod) {
    throw new Error("Payment method not found");
  }

  let verificationDetails: Record<string, unknown> = { method };
  let status: VerificationResult["status"] = "pending";

  if (method === "instant") {
    // Instant verification (wallets, etc.)
    status = "verified";
    verificationDetails = { ...verificationDetails, completedAt: new Date().toISOString() };
  } else if (method === "3ds") {
    // 3D Secure verification
    status = "verified";
    verificationDetails = {
      ...verificationDetails,
      threeDSecure: true,
      completedAt: new Date().toISOString(),
    };
  } else if (method === "microdeposit") {
    // Microdeposit verification
    status = details?.amount1 && details?.amount2 ? "verified" : "pending";
    verificationDetails = {
      ...verificationDetails,
      amount1: details?.amount1,
      amount2: details?.amount2,
      completedAt: status === "verified" ? new Date().toISOString() : undefined,
    };
  }

  // Update payment method
  await paymentMethod.update({
    verified: status === "verified",
    verificationMethod: method,
    lastUsedAt: status === "verified" ? new Date() : undefined,
  });

  // Log verification event
  await PaymentAuditLog.create({
    eventId: crypto.randomUUID(),
    eventType: "payment_method_verified",
    actorId: paymentMethod.customerId,
    actorType: "user",
    resourceId: paymentMethod.id,
    resourceType: "payment_method",
    details: verificationDetails,
  });

  return {
    paymentMethodId: paymentMethod.id,
    status,
    verificationDetails,
    completedAt: verificationDetails.completedAt as string | undefined,
  };
}

/**
 * Initiate verification for a payment method
 */
export async function initiateVerification(request: VerificationRequest): Promise<VerificationResult> {
  const paymentMethod = await PaymentMethod.findByPk(request.paymentMethodId);
  if (!paymentMethod) {
    throw new Error("Payment method not found");
  }

  if (paymentMethod.verified) {
    throw new Error("Payment method is already verified");
  }

  let verificationDetails: Record<string, unknown> = { method: request.method };
  let status: VerificationResult["status"] = "pending";

  if (request.method === "microdeposit") {
    // Simulate microdeposit amounts
    verificationDetails = {
      ...verificationDetails,
      amount1: 0,
      amount2: 0,
      pendingUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
    };
  } else if (request.method === "3ds") {
    verificationDetails = {
      ...verificationDetails,
      returnUrl: request.returnUrl,
      pendingUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  // Log verification request
  await PaymentAuditLog.create({
    eventId: crypto.randomUUID(),
    eventType: "payment_method_verified",
    actorId: paymentMethod.customerId,
    actorType: "user",
    resourceId: paymentMethod.id,
    resourceType: "payment_method",
    details: verificationDetails,
  });

  return {
    paymentMethodId: paymentMethod.id,
    status,
    verificationDetails,
  };
}

/**
 * List payment methods for a customer
 */
export async function listPaymentMethods(request: VaultListMethodsRequest): Promise<VaultListMethodsResponse> {
  const { customerId, status, type, page = 1, limit = 20 } = request;

  const where: any = { customerId };

  if (status) {
    where.status = status;
  }

  if (type) {
    where.type = type;
  }

  const offset = (page - 1) * limit;

  const { count, rows } = await PaymentMethod.findAndCountAll({
    where,
    limit,
    offset,
    order: [["createdAt", "DESC"]],
  });

  const totalPages = Math.ceil(count / limit);

  return {
    paymentMethods: rows as PaymentMethodType[],
    totalCount: count,
    page,
    limit,
    totalPages,
  };
}

/**
 * Update a payment method
 */
export async function updatePaymentMethod(
  paymentMethodId: string,
  request: VaultUpdateMethodRequest
): Promise<void> {
  const paymentMethod = await PaymentMethod.findByPk(paymentMethodId);
  if (!paymentMethod) {
    throw new Error("Payment method not found");
  }

  const updates: Partial<typeof request> = {};

  if (request.metadata !== undefined) {
    updates.metadata = { ...paymentMethod.metadata, ...request.metadata };
  }

  if (request.status !== undefined) {
    updates.status = request.status;
    if (request.status === "removed") {
      updates.removedAt = new Date();
    }
    if (request.status === "expired") {
      updates.lastUsedAt = new Date();
    }
  }

  if (request.threeDSecure !== undefined) {
    updates.threeDSecureEnabled = request.threeDSecure.enabled;
  }

  await paymentMethod.update(updates);

  // Log update event
  await PaymentAuditLog.create({
    eventId: crypto.randomUUID(),
    eventType: "payment_method_updated",
    actorId: paymentMethod.customerId,
    actorType: "user",
    resourceId: paymentMethod.id,
    resourceType: "payment_method",
    details: updates,
  });
}

/**
 * Remove a payment method
 */
export async function removePaymentMethod(
  paymentMethodId: string,
  request: VaultRemoveMethodRequest
): Promise<void> {
  const paymentMethod = await PaymentMethod.findByPk(paymentMethodId);
  if (!paymentMethod) {
    throw new Error("Payment method not found");
  }

  await paymentMethod.update({
    status: "removed",
    removedAt: new Date(),
  });

  // Log removal event
  await PaymentAuditLog.create({
    eventId: crypto.randomUUID(),
    eventType: "payment_method_removed",
    actorId: paymentMethod.customerId,
    actorType: "user",
    resourceId: paymentMethod.id,
    resourceType: "payment_method",
    details: {
      reason: request.reason,
      removedAt: new Date().toISOString(),
    },
  });
}

/**
 * Get payment method by ID
 */
export async function getPaymentMethod(paymentMethodId: string): Promise<PaymentMethodType | null> {
  const paymentMethod = await PaymentMethod.findByPk(paymentMethodId);
  if (!paymentMethod) {
    return null;
  }

  return paymentMethod as PaymentMethodType;
}

/**
 * Check if a payment method is expired
 */
export function checkPaymentMethodExpiry(paymentMethodId: string): boolean {
  const paymentMethod = PaymentMethod.findByPk(paymentMethodId);
  if (!paymentMethod) {
    return false;
  }

  return isPaymentMethodExpired(paymentMethod);
}

/**
 * Update payment method last used timestamp
 */
export async function markPaymentMethodUsed(paymentMethodId: string): Promise<void> {
  const paymentMethod = await PaymentMethod.findByPk(paymentMethodId);
  if (!paymentMethod) {
    throw new Error("Payment method not found");
  }

  await paymentMethod.update({
    lastUsedAt: new Date(),
  });

  // Log usage event
  await PaymentAuditLog.create({
    eventId: crypto.randomUUID(),
    eventType: "payment_method_updated",
    actorId: paymentMethod.customerId,
    actorType: "user",
    resourceId: paymentMethod.id,
    resourceType: "payment_method",
    details: {
      lastUsedAt: new Date().toISOString(),
    },
  });
}

/**
 * Check if payment method is usable
 */
export function isUsable(paymentMethodId: string): boolean {
  const paymentMethod = PaymentMethod.findByPk(paymentMethodId);
  if (!paymentMethod) {
    return false;
  }

  return isPaymentMethodUsable(paymentMethod);
}

import { ValidationError } from "../errors.js";

/**
 * Validate payment method data
 */
export function validateCardDetails(details: {
  number?: string;
  expMonth?: number;
  expYear?: number;
  cvc?: string;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!details.number || details.number.length < 13 || details.number.length > 19) {
    errors.push("Card number must be between 13 and 19 digits");
  }

  if (!isLuhnValid(details.number || "")) {
    errors.push("Invalid card number (Luhn check failed)");
  }

  if (details.expMonth !== undefined && (details.expMonth < 1 || details.expMonth > 12)) {
    errors.push("Expiry month must be between 1 and 12");
  }

  const currentYear = new Date().getFullYear();
  if (details.expYear !== undefined && details.expYear < currentYear) {
    errors.push("Card has expired");
  }

  if (details.cvc !== undefined && details.cvc.length < 3 || details.cvc.length > 4) {
    errors.push("CVC must be 3 or 4 digits");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate bank account details
 */
export function validateBankDetails(details: {
  accountNumber?: string;
  routingNumber?: string;
  accountType?: "checking" | "savings";
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!details.accountNumber || details.accountNumber.length < 5 || details.accountNumber.length > 17) {
    errors.push("Account number must be between 5 and 17 digits");
  }

  if (!details.routingNumber || details.routingNumber.length !== 9) {
    errors.push("Routing number must be exactly 9 digits");
  }

  if (!details.accountType) {
    errors.push("Account type is required (checking or savings)");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate wallet details
 */
export function validateWalletDetails(details: {
  walletType?: "apple_pay" | "google_pay" | "paypal" | "stellar";
  walletToken?: string;
  walletAddress?: string;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!details.walletType) {
    errors.push("Wallet type is required");
  }

  if (details.walletType !== "stellar" && !details.walletToken) {
    errors.push("Wallet token is required for this wallet type");
  }

  if (details.walletType === "stellar" && !details.walletAddress) {
    errors.push("Stellar address is required for Stellar wallet");
  }

  if (details.walletToken && details.walletToken.length < 10) {
    errors.push("Invalid wallet token");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate 3D Secure request
 */
export function validateThreeDSecureRequest(data: {
  paymentMethodId: string;
  amount: number;
  currency: string;
  merchantName: string;
  merchantCategoryCode: string;
  customerEmail: string;
  returnUrl: string;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!data.paymentMethodId) {
    errors.push("Payment method ID is required");
  }

  if (data.amount <= 0 || data.amount > 10000000) {
    errors.push("Amount must be between 0 and 10,000,000");
  }

  if (!data.currency || data.currency.length !== 3) {
    errors.push("Currency must be a valid 3-letter ISO code");
  }

  if (!data.merchantName || data.merchantName.length < 1 || data.merchantName.length > 50) {
    errors.push("Merchant name must be between 1 and 50 characters");
  }

  if (!data.merchantCategoryCode || data.merchantCategoryCode.length !== 4) {
    errors.push("Merchant category code must be exactly 4 digits");
  }

  if (!data.customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.customerEmail)) {
    errors.push("Valid customer email is required");
  }

  if (!data.returnUrl || !data.returnUrl.startsWith("https://")) {
    errors.push("Return URL must be a valid HTTPS URL");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate network tokenization request
 */
export function validateNetworkTokenizationRequest(data: {
  paymentMethodId: string;
  network: "visanet" | "mastercard-cvs" | "amex-epn" | "discover-dps";
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!data.paymentMethodId) {
    errors.push("Payment method ID is required");
  }

  if (!data.network) {
    errors.push("Network type is required");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Luhn algorithm for card number validation
 */
function isLuhnValid(cardNumber: string): boolean {
  let sum = 0;
  let isEven = false;

  for (let i = cardNumber.length - 1; i >= 0; i--) {
    let digit = parseInt(cardNumber[i], 10);

    if (isEven) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    isEven = !isEven;
  }

  return sum % 10 === 0;
}

/**
 * Format card number (mask all but last 4)
 */
export function formatCardNumber(cardNumber: string): string {
  const last4 = cardNumber.slice(-4);
  return `**** **** **** ${last4}`;
}

/**
 * Generate fingerprint for payment method
 */
export function generateFingerprint(
  type: string,
  details: Record<string, unknown>,
  customerId: string
): string {
  const data = JSON.stringify({
    type,
    details,
    customerId,
    timestamp: new Date().toISOString(),
  });
  
  // Simple hash function for fingerprint
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  
  return `fp_${hash.toString(16)}_${Date.now()}`;
}

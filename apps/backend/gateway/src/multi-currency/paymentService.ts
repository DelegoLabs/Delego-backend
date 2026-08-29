import { MultiCurrencyPayment } from "../models/MultiCurrencyPayment.js";
import { FXRate } from "../models/FXRate.js";
import { CurrencyExposure } from "../models/CurrencyExposure.js";
import { CurrencySettlement } from "../models/CurrencySettlement.js";
import { SupportedCurrency } from "../models/SupportedCurrency.js";
import { getFXRate, findConversionPath } from "./fxService.js";
import type {
  MultiCurrencyPayment as MultiCurrencyPaymentType,
  MultiCurrencyPaymentRequest,
  MultiCurrencyPaymentResponse,
  FXRate as FXRateType,
  ConversionPath,
} from "@delegolabs/types";

/**
 * Multi-Currency Payment Service
 * Handles payment creation, path payments, and settlement
 */

const STELLAR_FEE_BASE = 100; // 0.00001 XLM per operation

/**
 * Create a multi-currency payment
 */
export async function createMultiCurrencyPayment(
  request: MultiCurrencyPaymentRequest
): Promise<MultiCurrencyPaymentResponse> {
  const {
    sourceCurrency,
    sourceAmount,
    destinationCurrency,
    destinationAddress,
    destinationAmount: requestedDestinationAmount,
    settlementCurrency = destinationCurrency,
    metadata = {},
    requireFxRateLock = false,
    fxRate: providedFxRate,
  } = request;

  // Validate currencies
  const sourceConfig = await SupportedCurrency.findByPk(sourceCurrency);
  if (!sourceConfig || !sourceConfig.enabled) {
    throw new Error(`Source currency ${sourceCurrency} is not supported`);
  }

  const destConfig = await SupportedCurrency.findByPk(destinationCurrency);
  if (!destConfig || !destConfig.enabled) {
    throw new Error(`Destination currency ${destinationCurrency} is not supported`);
  }

  // Get or use provided FX rate
  let fxRate: FXRateType;
  if (providedFxRate) {
    fxRate = providedFxRate;
  } else {
    fxRate = await getFXRate({
      baseCurrency: sourceCurrency,
      quoteCurrency: destinationCurrency,
    });
  }

  // Calculate destination amount
  const destinationAmount = requestedDestinationAmount ||
    (parseFloat(sourceAmount) * parseFloat(fxRate.rate)).toString();

  // Find conversion path
  const conversionPathResult = await findConversionPath(sourceCurrency, destinationCurrency);

  // Calculate path payment amounts
  const path: ConversionPath[] = [];
  let currentAmount = parseFloat(sourceAmount);

  for (const step of conversionPathResult.path) {
    const amountOut = currentAmount * parseFloat(step.rate);
    path.push({
      from: step.from,
      to: step.to,
      rate: step.rate,
      amountOut: amountOut.toString(),
    });
    currentAmount = amountOut;
  }

  // Add slippage protection (1% minimum)
  const destinationMin = (parseFloat(destinationAmount) * 0.99).toString();

  // Create payment record
  const payment = await MultiCurrencyPayment.create({
    sourceCurrency,
    sourceAmount: sourceAmount,
    destinationCurrency,
    destinationAmount,
    fxRateId: fxRate.id || "manual",
    fxRateData: {
      baseCurrency: fxRate.baseCurrency,
      quoteCurrency: fxRate.quoteCurrency,
      rate: fxRate.rate,
      source: fxRate.source,
      timestamp: fxRate.timestamp,
      validUntil: fxRate.validUntil,
      spread: fxRate.spread,
    },
    conversionPath: path,
    settlementCurrency,
    status: "pending",
    sourceAddress: metadata.sourceAddress || "",
    destinationAddress,
    destinationMin,
    metadata,
  });

  // Update currency exposure
  await updateCurrencyExposure(sourceCurrency, sourceAmount, "long");
  await updateCurrencyExposure(destinationCurrency, destinationAmount, "short");

  return {
    paymentId: payment.id,
    sourceCurrency,
    sourceAmount,
    destinationCurrency,
    destinationAmount,
    fxRate,
    conversionPath: path,
    estimatedSettlementTime: `${fxRate.validUntil ? new Date(fxRate.validUntil).getTime() - new Date().getTime() : 60000}ms`,
  };
}

/**
 * Execute path payment for a multi-currency payment
 */
export async function executePathPayment(paymentId: string, transactionHash: string): Promise<MultiCurrencyPaymentType> {
  const payment = await MultiCurrencyPayment.findByPk(paymentId);
  if (!payment) {
    throw new Error("Payment not found");
  }

  payment.status = "converting";
  payment.stellarTransactionHash = transactionHash;
  await payment.save();

  // In a real implementation, this would:
  // 1. Submit path payment to Stellar network
  // 2. Wait for confirmation
  // 3. Update status on success/failure

  return payment as MultiCurrencyPaymentType;
}

/**
 * Complete a multi-currency payment
 */
export async function completeMultiCurrencyPayment(
  paymentId: string,
  ledgerSequence: number
): Promise<MultiCurrencyPaymentType> {
  const payment = await MultiCurrencyPayment.findByPk(paymentId);
  if (!payment) {
    throw new Error("Payment not found");
  }

  if (payment.status !== "converting") {
    throw new Error("Payment must be in converting status");
  }

  payment.status = "settled";
  payment.completedAt = new Date();
  payment.settlementStatus = "completed";
  payment.metadata = {
    ...payment.metadata,
    settlementLedger: ledgerSequence,
    settlementTime: new Date().toISOString(),
  };

  // Update settlement record
  await updateSettlement(payment.settlementCurrency, payment.destinationAmount, payment.id);

  await payment.save();

  return payment as MultiCurrencyPaymentType;
}

/**
 * Fail a multi-currency payment
 */
export async function failMultiCurrencyPayment(
  paymentId: string,
  reason: string
): Promise<MultiCurrencyPaymentType> {
  const payment = await MultiCurrencyPayment.findByPk(paymentId);
  if (!payment) {
    throw new Error("Payment not found");
  }

  payment.status = "failed";
  payment.failedAt = new Date();
  payment.failedReason = reason;
  payment.metadata = {
    ...payment.metadata,
    failureReason: reason,
  };

  // Reverse currency exposure
  await updateCurrencyExposure(payment.sourceCurrency, payment.sourceAmount, "short");
  await updateCurrencyExposure(payment.destinationCurrency, payment.destinationAmount, "long");

  await payment.save();

  return payment as MultiCurrencyPaymentType;
}

/**
 * Update currency exposure
 */
async function updateCurrencyExposure(
  currency: string,
  amount: string,
  direction: "long" | "short"
): Promise<void> {
  const exposure = await CurrencyExposure.findOne({ where: { currency } });

  const amountNum = parseFloat(amount);

  if (!exposure) {
    // Create new exposure
    await CurrencyExposure.create({
      currency,
      grossAmount: amount,
      netAmount: direction === "long" ? amount : `-${amount}`,
      unrealizedPnL: "0",
      hedgeRatio: 0,
      var95: (amountNum * 0.05).toString(),
      var99: (amountNum * 0.01).toString(),
      marginRequirement: (amountNum * 0.1).toString(),
      collateralRequired: (amountNum * 0.05).toString(),
      exposureDate: new Date(),
      hedgeStatus: "unhedged",
    });
  } else {
    // Update existing exposure
    let gross = parseFloat(exposure.grossAmount);
    let net = parseFloat(exposure.netAmount);

    if (direction === "long") {
      gross += amountNum;
      net += amountNum;
    } else {
      gross += amountNum;
      net -= amountNum;
    }

    exposure.grossAmount = gross.toString();
    exposure.netAmount = net.toString();
    exposure.var95 = (gross * 0.05).toString();
    exposure.var99 = (gross * 0.01).toString();
    exposure.marginRequirement = (gross * 0.1).toString();
    exposure.collateralRequired = (gross * 0.05).toString();
    exposure.exposureDate = new Date();

    // Determine hedge status
    if (exposure.hedgeRatio >= 0.9) {
      exposure.hedgeStatus = "fully_hedged";
    } else if (exposure.hedgeRatio > 0) {
      exposure.hedgeStatus = "partially_hedged";
    } else {
      exposure.hedgeStatus = "unhedged";
    }

    await exposure.save();
  }
}

/**
 * Update settlement record
 */
async function updateSettlement(
  currency: string,
  amount: string,
  paymentId: string
): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const settlement = await CurrencySettlement.findOne({
    where: {
      currency,
      settlementDate: {
        [CurrencySettlement.Sequelize.Op.gte]: today,
        [CurrencySettlement.Sequelize.Op.lt]: new Date(today.getTime() + 24 * 60 * 60 * 1000),
      },
    },
  });

  if (!settlement) {
    // Create new settlement
    await CurrencySettlement.create({
      currency,
      totalIn: "0",
      totalOut: "0",
      netAmount: "0",
      settlementDate: today,
      ledgerSequence: 0,
      status: "pending",
      transactions: [paymentId],
    });
  } else {
    // Update existing settlement
    const amountNum = parseFloat(amount);
    let totalIn = parseFloat(settlement.totalIn);
    let totalOut = parseFloat(settlement.totalOut);

    if (amountNum > 0) {
      totalIn += amountNum;
    } else {
      totalOut += Math.abs(amountNum);
    }

    settlement.totalIn = totalIn.toString();
    settlement.totalOut = totalOut.toString();
    settlement.netAmount = (totalIn - totalOut).toString();
    settlement.transactions = [...settlement.transactions, paymentId];

    await settlement.save();
  }
}

/**
 * Get payment by ID
 */
export async function getPayment(paymentId: string): Promise<MultiCurrencyPaymentType | null> {
  const payment = await MultiCurrencyPayment.findByPk(paymentId);
  if (!payment) {
    return null;
  }
  return payment as MultiCurrencyPaymentType;
}

/**
 * List payments with filters
 */
export async function listPayments(
  filters: {
    sourceCurrency?: string;
    destinationCurrency?: string;
    status?: string;
    page?: number;
    limit?: number;
  }
): Promise<{
  payments: MultiCurrencyPaymentType[];
  totalCount: number;
  page: number;
  limit: number;
  totalPages: number;
}> {
  const { sourceCurrency, destinationCurrency, status, page = 1, limit = 20 } = filters;

  const where: any = {};
  if (sourceCurrency) where.sourceCurrency = sourceCurrency;
  if (destinationCurrency) where.destinationCurrency = destinationCurrency;
  if (status) where.status = status;

  const offset = (page - 1) * limit;

  const { count, rows } = await MultiCurrencyPayment.findAndCountAll({
    where,
    limit,
    offset,
    order: [["createdAt", "DESC"]],
  });

  const totalPages = Math.ceil(count / limit);

  return {
    payments: rows as MultiCurrencyPaymentType[],
    totalCount: count,
    page,
    limit,
    totalPages,
  };
}

/**
 * Calculate currency exposure for an account
 */
export async function calculateAccountExposure(
  accountId: string
): Promise<MultiCurrencyPaymentType[]> {
  const payments = await MultiCurrencyPayment.findAll({
    where: {
      sourceAddress: accountId,
      status: { [MultiCurrencyPayment.Sequelize.Op.notIn]: ["failed", "cancelled"] },
    },
  });

  return payments as MultiCurrencyPaymentType[];
}

/**
 * Get auto-route for currency conversion
 */
export async function getAutoRoute(
  sourceCurrency: string,
  sourceAmount: string,
  destinationCurrency: string
): Promise<{ route: ConversionPath[]; estimatedRate: string; minimumRate: string }> {
  const result = await findConversionPath(sourceCurrency, destinationCurrency);

  const minimumRate = (parseFloat(result.totalRate) * 0.99).toString(); // 1% slippage buffer

  return {
    route: result.path,
    estimatedRate: result.totalRate,
    minimumRate,
  };
}

/**
 * Recurring Payment Subscriptions with Escrow (Issue #47).
 */

export type BillingInterval = "day" | "week" | "month" | "year";

export interface SubscriptionPlan {
  id: string;
  merchantId: string;
  name: string;
  description: string;
  /** In stroops. */
  amount: string;
  /** Token contract address. */
  currency: string;
  interval: BillingInterval;
  intervalCount: number;
  trialDays?: number;
  usageBased: boolean;
  /** In stroops — caps a usage-based charge; ignored for flat-rate plans. */
  maxAmount?: string;
  metadata: Record<string, unknown>;
  active: boolean;
  createdAt: string;
}

export type SubscriptionStatus = "active" | "paused" | "cancelled" | "past_due" | "trialing";

export interface SubscriptionPaymentMethod {
  type: "escrow" | "wallet";
  escrowContractId?: string;
}

export interface Subscription {
  id: string;
  planId: string;
  buyerAddress: string;
  sellerAddress: string;
  status: SubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEnd?: string;
  cancelAtPeriodEnd: boolean;
  paymentMethod: SubscriptionPaymentMethod;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type SubscriptionEventType =
  | "created"
  | "renewed"
  | "payment_failed"
  | "paused"
  | "cancelled"
  | "plan_changed";

export interface SubscriptionEvent {
  subscriptionId: string;
  type: SubscriptionEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Service-layer inputs
// ---------------------------------------------------------------------------

export interface CreateSubscriptionPlanInput {
  merchantId: string;
  name: string;
  description?: string;
  amount: string;
  currency: string;
  interval: BillingInterval;
  intervalCount?: number;
  trialDays?: number;
  usageBased?: boolean;
  maxAmount?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateSubscriptionInput {
  planId: string;
  buyerAddress: string;
  sellerAddress: string;
  paymentMethod: SubscriptionPaymentMethod;
  metadata?: Record<string, unknown>;
  /** Overrides the plan's trialDays (e.g. a promo). Pass 0 to skip the trial. */
  trialDaysOverride?: number;
}

export interface RenewSubscriptionOptions {
  /** For usage-based plans — the metered amount to charge this period, capped at plan.maxAmount. */
  usageAmount?: string;
  /** Bypasses the currentPeriodEnd due-date check — used by explicit/manual renewal requests. */
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SubscriptionPlanNotFoundError extends Error {
  constructor(public readonly planId: string) {
    super(`Subscription plan ${planId} not found`);
    this.name = "SubscriptionPlanNotFoundError";
  }
}

export class SubscriptionNotFoundError extends Error {
  constructor(public readonly subscriptionId: string) {
    super(`Subscription ${subscriptionId} not found`);
    this.name = "SubscriptionNotFoundError";
  }
}

export class SubscriptionNotActiveError extends Error {
  constructor(
    public readonly subscriptionId: string,
    public readonly status: SubscriptionStatus
  ) {
    super(`Subscription ${subscriptionId} is "${status}" and cannot be modified this way`);
    this.name = "SubscriptionNotActiveError";
  }
}

export class UnsupportedPaymentMethodError extends Error {
  constructor(type: string) {
    super(`Subscription billing for payment method "${type}" is not supported yet`);
    this.name = "UnsupportedPaymentMethodError";
  }
}

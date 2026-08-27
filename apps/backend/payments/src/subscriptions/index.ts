/** Recurring Payment Subscriptions with Escrow (Issue #47) — public API. */

export {
  cancelSubscription,
  changeSubscriptionPlan,
  createSubscription,
  createSubscriptionPlan,
  getSubscription,
  getSubscriptionPlan,
  pauseSubscription,
  renewSubscription,
  resumeSubscription,
  type CancelSubscriptionOptions,
} from "./service.js";

export { chargeSubscriptionPeriod } from "./billing.js";
export { addBillingInterval, computeInitialPeriod } from "./billingCycle.js";
export { runBillingCycle, startSubscriptionBillingScheduler, type BillingCycleResult } from "./billingScheduler.js";

export {
  enablePostgresPlanStore,
  getPlanStore,
  resetPlanStore,
  setPlanStore,
  InMemoryPlanStore,
  type PlanStore,
} from "./planStore.js";
export {
  enablePostgresSubscriptionStore,
  getSubscriptionStore,
  resetSubscriptionStore,
  setSubscriptionStore,
  InMemorySubscriptionStore,
  type SubscriptionStore,
} from "./subscriptionStore.js";
export {
  enablePostgresChargeStore,
  getChargeStore,
  resetChargeStore,
  setChargeStore,
  InMemoryChargeStore,
  type ChargeStore,
  type SubscriptionCharge,
} from "./chargeStore.js";

export { emitSubscriptionEvent } from "./notifications.js";

export type {
  BillingInterval,
  CreateSubscriptionInput,
  CreateSubscriptionPlanInput,
  RenewSubscriptionOptions,
  Subscription,
  SubscriptionEvent,
  SubscriptionPaymentMethod,
  SubscriptionPlan,
  SubscriptionStatus,
} from "./types.js";
export {
  SubscriptionNotActiveError,
  SubscriptionNotFoundError,
  SubscriptionPlanNotFoundError,
  UnsupportedPaymentMethodError,
} from "./types.js";

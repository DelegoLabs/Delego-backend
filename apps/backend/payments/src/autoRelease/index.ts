/** Escrow Auto-Release on Delivery Confirmation (Issue #45) — public API. */

export {
  adminOverrideRelease,
  executeAutoRelease,
  handleDeliveryConfirmation,
  type AdminOverrideReleaseParams,
  type AutoReleaseOutcome,
  type ExecuteAutoReleaseParams,
  type ScheduledReleaseAck,
} from "./service.js";

export {
  getAutoReleaseConfig,
  setAutoReleaseConfig,
  setAutoReleaseConfigStore,
  resetAutoReleaseConfigStore,
  InMemoryAutoReleaseConfigStore,
  type AutoReleaseConfigStore,
} from "./configStore.js";

export {
  getConfirmationCount,
  resetConfirmationTracker,
  setConfirmationTracker,
  type ConfirmationTracker,
} from "./confirmationTracker.js";

export { getWebhookSecret, verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from "./hmac.js";

export { retryWithBackoff, type RetryOptions, type RetryResult } from "./retry.js";

export {
  pendingReleaseJobCount,
  resetReleaseQueue,
  runDueReleaseJobs,
  scheduleRelease,
  type ScheduledReleaseJob,
  type ScheduleResult,
} from "./releaseQueue.js";

export { emitAutoReleaseEvent } from "./events.js";

export type {
  AutoReleaseConfig,
  AutoReleaseEvent,
  AutoReleaseEventPayload,
  AutoReleaseEventType,
  DeliveryConfirmation,
  DeliveryProof,
  ReleaseResult,
} from "./types.js";
export {
  DEFAULT_AUTO_RELEASE_CONFIG,
  EscrowDisputedError,
  EscrowNotReleasableError,
  InvalidWebhookSignatureError,
} from "./types.js";

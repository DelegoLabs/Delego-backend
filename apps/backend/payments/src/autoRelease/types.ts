/**
 * Escrow Auto-Release on Delivery Confirmation (Issue #45)
 *
 * Shared types for the delivery-confirmation webhook, the per-escrow
 * auto-release configuration, and the result of a (partial or full)
 * on-chain release attempt.
 */

/** Proof-of-delivery evidence attached to a delivery confirmation. */
export interface DeliveryProof {
  trackingNumber?: string;
  carrier?: string;
  deliveredAt: string;
  recipientSignature?: string;
  photos?: string[];
  gpsCoordinates?: {
    lat: number;
    lng: number;
  };
}

/** Payload delivered by the `/escrow/:escrowId/delivery-confirmed` webhook. */
export interface DeliveryConfirmation {
  escrowId: string;
  orderId: string;
  deliveryProof: DeliveryProof;
  /** Merchant ID or Delivery Agent ID that confirmed delivery. */
  confirmedBy: string;
  timestamp: string;
}

/** Per-escrow configuration controlling how auto-release behaves. */
export interface AutoReleaseConfig {
  escrowId: string;
  enabled: boolean;
  /** Minutes to wait before releasing. Default: 0 (immediate). */
  delayMinutes: number;
  partialReleaseEnabled: boolean;
  /** Number of delivery confirmations required to release the full amount. */
  requiredConfirmations: number;
}

/** Default configuration applied when no per-escrow override is set. */
export const DEFAULT_AUTO_RELEASE_CONFIG: Omit<AutoReleaseConfig, "escrowId"> = {
  enabled: true,
  delayMinutes: 0,
  partialReleaseEnabled: false,
  requiredConfirmations: 1,
};

/** Outcome of an (attempted) escrow release triggered by delivery confirmation. */
export interface ReleaseResult {
  escrowId: string;
  success: boolean;
  transactionHash?: string;
  releasedAmount: string;
  remainingAmount: string;
  error?: string;
  retryCount: number;
}

/** Domain events emitted at each stage of the auto-release lifecycle. */
export type AutoReleaseEventType =
  | "release_initiated"
  | "release_completed"
  | "release_failed";

export interface AutoReleaseEventPayload {
  escrowId: string;
  orderId: string;
  confirmedBy?: string;
  releasedAmount?: string;
  remainingAmount?: string;
  transactionHash?: string;
  retryCount?: number;
  reason?: string;
}

export interface AutoReleaseEvent {
  type: AutoReleaseEventType;
  escrowId: string;
  orderId: string;
  occurredAt: string;
  payload: AutoReleaseEventPayload;
}

/** Raised when a webhook signature fails HMAC verification. */
export class InvalidWebhookSignatureError extends Error {
  constructor(message = "Webhook signature verification failed") {
    super(message);
    this.name = "InvalidWebhookSignatureError";
  }
}

/** Raised when an escrow is not in a state that allows auto-release. */
export class EscrowNotReleasableError extends Error {
  constructor(
    public readonly escrowId: string,
    public readonly currentStatus: string
  ) {
    super(`Escrow ${escrowId} is not releasable from status "${currentStatus}"`);
    this.name = "EscrowNotReleasableError";
  }
}

/** Raised when auto-release is attempted on a disputed escrow. */
export class EscrowDisputedError extends Error {
  constructor(public readonly escrowId: string) {
    super(`Escrow ${escrowId} is disputed; auto-release is blocked pending manual override`);
    this.name = "EscrowDisputedError";
  }
}

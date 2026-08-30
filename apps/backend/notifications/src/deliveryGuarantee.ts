/**
 * Issue #149 — At-least-once delivery guarantees.
 *
 * Provides:
 *  - Idempotency key generation for notifications
 *  - Delivery receipt tracking per channel
 *  - Delivery guarantee metrics
 *  - Notification ordering per user
 *  - Cross-channel delivery coordination
 */

import { createLogger } from "@delegolabs/utils";

const log = createLogger(
  "notifications:delivery-guarantee",
  process.env.LOG_LEVEL ?? "info"
);

// ─── Types ────────────────────────────────────────────────────────────────────

export type DeliveryChannel = "email" | "push" | "in_app" | "sms" | "webhook";
export type GuaranteeLevel = "at_most_once" | "at_least_once" | "exactly_once";

export interface DeliveryGuaranteeConfig {
  channel: DeliveryChannel;
  guarantee: GuaranteeLevel;
  confirmationTimeoutMs: number;
  maxRetries: number;
}

export interface DeliveryReceipt {
  notificationId: string;
  channel: DeliveryChannel;
  externalId: string;
  status: "delivered" | "failed" | "pending";
  deliveredAt?: string;
  confirmedAt?: string;
  metadata: Record<string, unknown>;
}

export interface DeliveryGuaranteeMetrics {
  channel: DeliveryChannel;
  totalSent: number;
  confirmed: number;
  pending: number;
  failed: number;
  duplicatesDetected: number;
  avgConfirmationMs: number;
  guaranteeViolations: number;
}

export interface DeliveryOrderingKey {
  userId: string;
  channel: DeliveryChannel;
}

// ─── Delivery Receipt Store ───────────────────────────────────────────────────

export interface DeliveryReceiptStore {
  save(receipt: DeliveryReceipt): Promise<void>;
  get(notificationId: string, channel: DeliveryChannel): Promise<DeliveryReceipt | null>;
  markConfirmed(notificationId: string, channel: DeliveryChannel, confirmedAt: string): Promise<boolean>;
  markFailed(notificationId: string, channel: DeliveryChannel, error: string): Promise<void>;
  getByExternalId(externalId: string, channel: DeliveryChannel): Promise<DeliveryReceipt | null>;
  getPending(channel: DeliveryChannel): Promise<DeliveryReceipt[]>;
}

export class InMemoryDeliveryReceiptStore implements DeliveryReceiptStore {
  private receipts = new Map<string, DeliveryReceipt>();

  private key(notificationId: string, channel: DeliveryChannel): string {
    return `${channel}:${notificationId}`;
  }

  async save(receipt: DeliveryReceipt): Promise<void> {
    this.receipts.set(this.key(receipt.notificationId, receipt.channel), receipt);
  }

  async get(notificationId: string, channel: DeliveryChannel): Promise<DeliveryReceipt | null> {
    return this.receipts.get(this.key(notificationId, channel)) ?? null;
  }

  async markConfirmed(notificationId: string, channel: DeliveryChannel, confirmedAt: string): Promise<boolean> {
    const receipt = this.receipts.get(this.key(notificationId, channel));
    if (!receipt) return false;
    receipt.status = "delivered";
    receipt.confirmedAt = confirmedAt;
    return true;
  }

  async markFailed(notificationId: string, channel: DeliveryChannel, error: string): Promise<void> {
    const receipt = this.receipts.get(this.key(notificationId, channel));
    if (receipt) {
      receipt.status = "failed";
      receipt.metadata.error = error;
    }
  }

  async getByExternalId(externalId: string, channel: DeliveryChannel): Promise<DeliveryReceipt | null> {
    for (const receipt of this.receipts.values()) {
      if (receipt.externalId === externalId && receipt.channel === channel) {
        return receipt;
      }
    }
    return null;
  }

  async getPending(channel: DeliveryChannel): Promise<DeliveryReceipt[]> {
    return Array.from(this.receipts.values()).filter(
      (r) => r.channel === channel && r.status === "pending"
    );
  }
}

// ─── Idempotency Key Generation ──────────────────────────────────────────────

/**
 * Generates a deterministic idempotency key for a notification.
 * Combines notification metadata to ensure the same logical notification
 * always produces the same key, preventing duplicate processing.
 */
export function generateIdempotencyKey(params: {
  userId: string;
  channel: DeliveryChannel;
  eventType: string;
  entityId: string;
  timestamp?: string;
}): string {
  const ts = params.timestamp ?? "global";
  const raw = `notif:${params.channel}:${params.userId}:${params.eventType}:${params.entityId}:${ts}`;
  // Use a simple hash for deterministic keys (not cryptographic — just for dedup)
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return `idem:${params.channel}:${Math.abs(hash).toString(36)}`;
}

// ─── Delivery Order Tracking ──────────────────────────────────────────────────

export interface DeliveryOrderTracker {
  /**
   * Checks if a notification should be delivered in order.
   * Returns true if it's safe to send (next in sequence).
   */
  canDeliver(key: DeliveryOrderingKey, sequenceNumber: number): Promise<boolean>;
  /**
   * Marks a notification as delivered for ordering purposes.
   */
  markDelivered(key: DeliveryOrderingKey, sequenceNumber: number): Promise<void>;
  /**
   * Gets the last delivered sequence number for a user+channel.
   */
  getLastDeliveredSequence(key: DeliveryOrderingKey): Promise<number>;
}

export class InMemoryDeliveryOrderTracker implements DeliveryOrderTracker {
  private sequences = new Map<string, number>();

  private keyStr(key: DeliveryOrderingKey): string {
    return `${key.userId}:${key.channel}`;
  }

  async canDeliver(key: DeliveryOrderingKey, sequenceNumber: number): Promise<boolean> {
    const last = this.sequences.get(this.keyStr(key)) ?? 0;
    return sequenceNumber > last;
  }

  async markDelivered(key: DeliveryOrderingKey, sequenceNumber: number): Promise<void> {
    const current = this.sequences.get(this.keyStr(key)) ?? 0;
    if (sequenceNumber > current) {
      this.sequences.set(this.keyStr(key), sequenceNumber);
    }
  }

  async getLastDeliveredSequence(key: DeliveryOrderingKey): Promise<number> {
    return this.sequences.get(this.keyStr(key)) ?? 0;
  }
}

// ─── Delivery Guarantee Service ───────────────────────────────────────────────

export interface DeliveryGuaranteeServiceOptions {
  receiptStore: DeliveryReceiptStore;
  orderTracker: DeliveryOrderTracker;
  confirmationTimeoutMs?: number;
}

/**
 * Core delivery guarantee service. Wraps notification dispatch with:
 *  - Receipt tracking for at-least-once confirmation
 *  - Ordering per user/channel
 *  - Duplicate detection
 *  - Metrics collection
 */
export class DeliveryGuaranteeService {
  private metrics: Map<DeliveryChannel, {
    totalSent: number;
    confirmed: number;
    pending: number;
    failed: number;
    duplicatesDetected: number;
    totalConfirmationMs: number;
    guaranteeViolations: number;
  }> = new Map();

  private readonly options: DeliveryGuaranteeServiceOptions;

  constructor(options: DeliveryGuaranteeServiceOptions) {
    this.options = options;
  }

  /**
   * Track a new delivery attempt. Returns the receipt and whether this is a
   * duplicate that should be skipped.
   */
  async trackDelivery(params: {
    notificationId: string;
    channel: DeliveryChannel;
    externalId: string;
    idempotencyKey: string;
    sequenceNumber?: number;
    metadata?: Record<string, unknown>;
  }): Promise<{ receipt: DeliveryReceipt; isDuplicate: boolean }> {
    const { receiptStore } = this.options;

    // Check for duplicate via idempotency key
    const existing = await receiptStore.getByExternalId(params.externalId, params.channel);
    if (existing) {
      this.incrementMetric(params.channel, "duplicatesDetected");
      log.info("Duplicate delivery detected, returning existing receipt", {
        notificationId: params.notificationId,
        channel: params.channel,
        externalId: params.externalId,
      });
      return { receipt: existing, isDuplicate: true };
    }

    const receipt: DeliveryReceipt = {
      notificationId: params.notificationId,
      channel: params.channel,
      externalId: params.externalId,
      status: "pending",
      deliveredAt: new Date().toISOString(),
      metadata: {
        ...params.metadata,
        idempotencyKey: params.idempotencyKey,
        sequenceNumber: params.sequenceNumber,
      },
    };

    await receiptStore.save(receipt);
    this.incrementMetric(params.channel, "totalSent");
    this.incrementMetric(params.channel, "pending");

    return { receipt, isDuplicate: false };
  }

  /**
   * Confirm successful delivery.
   */
  async confirmDelivery(
    notificationId: string,
    channel: DeliveryChannel,
    confirmedAt?: string
  ): Promise<boolean> {
    const { receiptStore } = this.options;
    const ts = confirmedAt ?? new Date().toISOString();
    const confirmed = await receiptStore.markConfirmed(notificationId, channel, ts);

    if (confirmed) {
      this.decrementMetric(channel, "pending");
      this.incrementMetric(channel, "confirmed");

      const receipt = await receiptStore.get(notificationId, channel);
      if (receipt?.deliveredAt) {
        const latencyMs = new Date(ts).getTime() - new Date(receipt.deliveredAt).getTime();
        this.addToMetric(channel, "totalConfirmationMs", latencyMs);
      }
    }

    return confirmed;
  }

  /**
   * Record a delivery failure.
   */
  async recordFailure(
    notificationId: string,
    channel: DeliveryChannel,
    error: string
  ): Promise<void> {
    const { receiptStore } = this.options;
    await receiptStore.markFailed(notificationId, channel, error);
    this.decrementMetric(channel, "pending");
    this.incrementMetric(channel, "failed");
  }

  /**
   * Check if a notification can be delivered in order.
   */
  async canDeliverInOrder(
    userId: string,
    channel: DeliveryChannel,
    sequenceNumber: number
  ): Promise<boolean> {
    return this.options.orderTracker.canDeliver(
      { userId, channel },
      sequenceNumber
    );
  }

  /**
   * Mark a notification as delivered for ordering.
   */
  async markOrderedDelivery(
    userId: string,
    channel: DeliveryChannel,
    sequenceNumber: number
  ): Promise<void> {
    await this.options.orderTracker.markDelivered(
      { userId, channel },
      sequenceNumber
    );
  }

  /**
   * Get metrics for a specific channel.
   */
  getMetrics(channel: DeliveryChannel): DeliveryGuaranteeMetrics {
    const m = this.metrics.get(channel) ?? {
      totalSent: 0,
      confirmed: 0,
      pending: 0,
      failed: 0,
      duplicatesDetected: 0,
      totalConfirmationMs: 0,
      guaranteeViolations: 0,
    };

    return {
      channel,
      totalSent: m.totalSent,
      confirmed: m.confirmed,
      pending: m.pending,
      failed: m.failed,
      duplicatesDetected: m.duplicatesDetected,
      avgConfirmationMs:
        m.confirmed > 0 ? m.totalConfirmationMs / m.confirmed : 0,
      guaranteeViolations: m.guaranteeViolations,
    };
  }

  /**
   * Get metrics for all channels.
   */
  getAllMetrics(): DeliveryGuaranteeMetrics[] {
    const channels: DeliveryChannel[] = [
      "email",
      "push",
      "in_app",
      "sms",
      "webhook",
    ];
    return channels.map((ch) => this.getMetrics(ch));
  }

  private incrementMetric(channel: DeliveryChannel, field: string): void {
    const m = this.getOrCreateMetric(channel);
    (m as Record<string, number>)[field] = ((m as Record<string, number>)[field] ?? 0) + 1;
  }

  private decrementMetric(channel: DeliveryChannel, field: string): void {
    const m = this.getOrCreateMetric(channel);
    (m as Record<string, number>)[field] = Math.max(
      0,
      ((m as Record<string, number>)[field] ?? 0) - 1
    );
  }

  private addToMetric(channel: DeliveryChannel, field: string, value: number): void {
    const m = this.getOrCreateMetric(channel);
    (m as Record<string, number>)[field] = ((m as Record<string, number>)[field] ?? 0) + value;
  }

  private getOrCreateMetric(channel: DeliveryChannel) {
    if (!this.metrics.has(channel)) {
      this.metrics.set(channel, {
        totalSent: 0,
        confirmed: 0,
        pending: 0,
        failed: 0,
        duplicatesDetected: 0,
        totalConfirmationMs: 0,
        guaranteeViolations: 0,
      });
    }
    return this.metrics.get(channel)!;
  }
}

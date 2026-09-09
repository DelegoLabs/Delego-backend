/**
 * Issue #123 — Redis Pub/Sub types.
 *
 * Defines the data structures for real-time event broadcasting
 * across service instances.
 */

// ─── Channel Configuration ──────────────────────────────────────────────────

export interface PubSubChannel {
  name: string;
  pattern: string;
  description: string;
  retentionMs: number;
  maxSubscribers: number;
}

// ─── Message Types ──────────────────────────────────────────────────────────

export interface PubSubMessage<T = unknown> {
  id: string;
  channel: string;
  type: string;
  payload: T;
  headers: Record<string, string>;
  timestamp: string;
  publisherId: string;
  correlationId?: string;
}

// ─── Subscription Types ─────────────────────────────────────────────────────

export type MessageHandler<T = unknown> = (message: PubSubMessage<T>) => Promise<void>;

export interface PubSubSubscription<T = unknown> {
  id: string;
  channel: string;
  pattern: boolean;
  subscriberId: string;
  callback: MessageHandler<T>;
  ackRequired: boolean;
  filter?: (message: PubSubMessage<T>) => boolean;
  maxRetries: number;
  retryDelayMs: number;
}

// ─── Metrics Types ──────────────────────────────────────────────────────────

export interface PubSubMetrics {
  channel: string;
  messagesPublished: number;
  messagesDelivered: number;
  activeSubscribers: number;
  avgLatencyMs: number;
  failedDeliveries: number;
  deadLettered: number;
  lastPublishedAt?: string;
  lastDeliveredAt?: string;
}

// ─── Dead Letter Types ──────────────────────────────────────────────────────

export interface DeadLetterMessage {
  message: PubSubMessage;
  error: string;
  attempts: number;
  failedAt: string;
  subscriptionId: string;
}

// ─── Serialization Types ────────────────────────────────────────────────────

export type SerializationFormat = "json" | "msgpack";

export interface Serializer {
  serialize(data: unknown): Buffer;
  deserialize(data: Buffer): unknown;
  format: SerializationFormat;
}

// ─── Connection Types ───────────────────────────────────────────────────────

export interface RedisPubSubConfig {
  url: string;
  serializer: SerializationFormat;
  maxRetriesPerRequest: number;
  retryDelayMs: number;
  healthCheckIntervalMs: number;
  reconnectOnClose: boolean;
  enableMetrics: boolean;
}

/** Alias used by consumers of the Pub/Sub module. */
export type PubSubConfig = RedisPubSubConfig;

// ─── Health Check Types ─────────────────────────────────────────────────────

export interface PubSubHealth {
  connected: boolean;
  channels: number;
  subscribers: number;
  uptime: number;
  lastError?: string;
  lastErrorAt?: string;
}

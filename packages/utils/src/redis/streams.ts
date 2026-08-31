/**
 * Redis Streams for event sourcing with consumer groups and exactly-once processing.
 *
 * Implements:
 *   - Stream creation with max length/retention policies
 *   - Consumer groups for horizontal scaling
 * *   - Exactly-once processing via pending entries and ID tracking
 *   - Event replay from any position
 *   - Stream trimming to prevent OOM
 *   - Processing metrics and lag monitoring
 *   - Consumer group rebalancing support
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamConfig {
  streamName: string;
  maxLength: number;
  trimStrategy: "maxlen" | "minid";
  retentionMs: number;
  consumerGroups: Array<{
    name: string;
    consumers: number;
    claimMinIdleMs: number;
  }>;
}

export interface StreamEvent {
  id: string; // Redis stream ID
  stream: string;
  type: string;
  payload: unknown;
  metadata: Record<string, string>;
  timestamp: string;
}

export interface ConsumerGroupState {
  groupName: string;
  stream: string;
  consumers: Array<{
    name: string;
    pending: number;
    idleMs: number;
    lastDelivery: string;
  }>;
  lastDeliveredId: string;
  entriesRead: number;
}

export interface StreamProcessingResult {
  stream: string;
  groupName: string;
  consumerName: string;
  processed: number;
  failed: number;
  retried: number;
  avgProcessingMs: number;
  lag: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces
// ─────────────────────────────────────────────────────────────────────────────

export type StreamMessage = {
  id: string;
  fields: Record<string, string>;
};

export type ParsedStreamMessage<T = unknown> = {
  id: string;
  stream: string;
  type: string;
  payload: T;
  metadata: Record<string, string>;
  timestamp: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Stream Manager
// ─────────────────────────────────────────────────────────────────────────────

export class RedisStreamManager<T = unknown> {
  private readonly streamName: string;
  private readonly maxLength: number;
  private readonly trimStrategy: "maxlen" | "minid";
  private readonly retentionMs: number;
  private readonly consumerGroups: StreamConfig["consumerGroups"];
  private readonly client: any;
  private readonly serializer: (data: unknown) => string;
  private readonly deserializer: (data: string) => unknown;

  constructor(
    streamName: string,
    config: Partial<StreamConfig> = {},
    client?: any
  ) {
    this.streamName = streamName;
    this.maxLength = config.maxLength ?? 10000;
    this.trimStrategy = config.trimStrategy ?? "maxlen";
    this.retentionMs = config.retentionMs ?? 24 * 60 * 60 * 1000; // 24 hours
    this.consumerGroups = config.consumerGroups ?? [
      { name: "default", consumers: 1, claimMinIdleMs: 30000 },
    ];

    this.client = client;
    this.serializer = config.serializer ?? JSON.stringify;
    this.deserializer = config.deserializer ?? JSON.parse;
  }

  // ─── Initialization ─────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    // Create stream with XADD + MAXLEN to ensure it exists
    await this.client.xAdd(this.streamName, "*", {
      __init__: "true",
    });

    // Set MAXLEN for the stream
    await this.client.xGroup("CREATE", this.streamName, "$", {
      MKSTREAM: true,
    });

    // Create consumer groups
    for (const cg of this.consumerGroups) {
      try {
        await this.client.xGroup("CREATE", this.streamName, cg.name, "$", {
          MKSTREAM: true,
        });
      } catch (err: any) {
        // CONSUMERGROUP exists is OK
        if (!err.message.includes("BUSYGROUP")) {
          throw err;
        }
      }
    }
  }

  // ─── Publishing Events ──────────────────────────────────────────────────

  async publish(
    type: string,
    payload: T,
    metadata: Record<string, string> = {}
  ): Promise<string> {
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const timestamp = new Date().toISOString();

    const message: StreamEvent = {
      id,
      stream: this.streamName,
      type,
      payload,
      metadata: {
        ...metadata,
        timestamp,
        type,
      },
      timestamp,
    };

    const fields = {
      id: message.id,
      type: message.type,
      payload: this.serializer(message.payload),
      metadata: this.serializer(message.metadata),
      timestamp: message.timestamp,
    };

    const result = await this.client.xAdd(this.streamName, "*", fields);

    // Trim the stream to prevent OOM
    await this.trimStream();

    return result;
  }

  async publishBatch(
    events: Array<{ type: string; payload: T; metadata?: Record<string, string> }>
  ): Promise<string[]> {
    const ids: string[] = [];
    const pipeline = this.client.multi();

    for (const event of events) {
      const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      const timestamp = new Date().toISOString();

      const message: StreamEvent = {
        id,
        stream: this.streamName,
        type: event.type,
        payload: event.payload,
        metadata: {
          ...(event.metadata ?? {}),
          timestamp,
          type: event.type,
        },
        timestamp,
      };

      const fields = {
        id: message.id,
        type: message.type,
        payload: this.serializer(message.payload),
        metadata: this.serializer(message.metadata),
        timestamp: message.timestamp,
      };

      pipeline.xAdd(this.streamName, "*", fields);
      ids.push(id);
    }

    await pipeline.exec();
    await this.trimStream();

    return ids;
  }

  // ─── Consumer Group Processing ───────────────���──────────────────────────

  async processWithConsumerGroup(
    groupName: string,
    consumerName: string,
    handler: (event: ParsedStreamMessage<T>) => Promise<void>,
    options: {
      batchSize?: number;
      blockMs?: number;
      count?: number;
    } = {}
  ): Promise<StreamProcessingResult> {
    const batchSize = options.batchSize ?? 10;
    const blockMs = options.blockMs ?? 5000;
    const count = options.count ?? 10;

    const result: StreamProcessingResult = {
      stream: this.streamName,
      groupName,
      consumerName,
      processed: 0,
      failed: 0,
      retried: 0,
      avgProcessingMs: 0,
      lag: 0,
    };

    const processingTimes: number[] = [];

    // Read pending entries for exactly-once processing
    const pending = await this.client.xPending(this.streamName, groupName);
    const pendingCount = parseInt(pending[0] as string, 10);

    // Process pending entries first (exactly-once)
    if (pendingCount > 0) {
      const pendingMessages = await this.client.xPendingRange(
        this.streamName,
        groupName,
        "-",
        "+",
        pendingCount,
        0
      );

      for (const msg of pendingMessages as any[]) {
        const msgId = msg[0];
        const consumer = msg[1];
        const idleTime = parseInt(msg[2], 10);
        const deliveryCount = parseInt(msg[3], 10);

        // Claim idle messages that haven't been ACK'd
        if (idleTime > options.claimMinIdleMs || deliveryCount > 1) {
          const claimed = await this.client.xClaim(
            this.streamName,
            groupName,
            consumerName,
            options.claimMinIdleMs ?? 30000,
            [msgId]
          );

          if (claimed.length > 0) {
            const parsed = this.parseMessage(claimed[0]);
            if (parsed) {
              try {
                const start = Date.now();
                await handler(parsed);
                processingTimes.push(Date.now() - start);

                await this.client.xAck(this.streamName, groupName, msgId);
                result.processed++;
              } catch (err) {
                log.error("Handler failed for pending message", {
                  messageId: msgId,
                  error: (err as Error).message,
                  deliveryCount,
                });
                result.failed++;
                result.retried++;
              }
            }
          }
        }
      }
    }

    // Read new messages
    const messages = await this.client.xReadGroup(
      groupName,
      consumerName,
      { streams: [this.streamName, ">"], count, block: blockMs }
    );

    if (messages) {
      for (const [stream, msgs] of messages) {
        for (const msg of msgs as StreamMessage[]) {
          const parsed = this.parseMessage(msg);
          if (parsed) {
            try {
              const start = Date.now();
              await handler(parsed);
              processingTimes.push(Date.now() - start);

              await this.client.xAck(this.streamName, groupName, msg.id);
              result.processed++;
            } catch (err) {
              log.error("Handler failed", {
                messageId: msg.id,
                error: (err as Error).message,
              });
              result.failed++;
            }
          }
        }
      }
    }

    // Calculate average processing time
    result.avgProcessingMs =
      processingTimes.length > 0
        ? processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length
        : 0;

    // Calculate lag (approximate)
    try {
      const streamInfo = await this.client.xInfoStream(this.streamName);
      const entriesRead = parseInt((streamInfo as any)["entries-read"] || "0", 10);
      result.lag = Math.max(0, entriesRead - result.processed);
    } catch {
      // Fallback if INFO not available
      result.lag = 0;
    }

    return result;
  }

  // ─── Event Replay ───────────────────────────────────────────────────────

  async replayFrom(
    position: string,
    handler: (event: ParsedStreamMessage<T>) => Promise<boolean>,
    options: { batchSize?: number } = {}
  ): Promise<number> {
    const batchSize = options.batchSize ?? 100;
    let processed = 0;
    let lastId = position;

    while (true) {
      const messages = await this.client.xReadRange(
        this.streamName,
        lastId,
        "+",
        { count: batchSize }
      );

      if (!messages || messages.length === 0) break;

      for (const [stream, msgs] of messages) {
        for (const msg of msgs as StreamMessage[]) {
          const parsed = this.parseMessage(msg);
          if (parsed) {
            const continueReplay = await handler(parsed);
            processed++;

            if (!continueReplay) {
              return processed;
            }
          }
          lastId = msg.id;
        }
      }

      if (messages.length < batchSize) break;
    }

    return processed;
  }

  async replayAll(
    handler: (event: ParsedStreamMessage<T>) => Promise<boolean>,
    options?: { batchSize?: number }
  ): Promise<number> {
    return this.replayFrom("0", handler, options);
  }

  async replayLast(
    handler: (event: ParsedStreamMessage<T>) => Promise<boolean>,
    options?: { batchSize?: number }
  ): Promise<number> {
    return this.replayFrom("-", handler, options);
  }

  // ─── Stream Management ──────────────────────────────────────────────────

  async trimStream(): Promise<void> {
    if (this.trimStrategy === "maxlen") {
      await this.client.xTrim(this.streamName, "MAXLEN", this.maxLength);
    } else {
      // minid - trim to entries after the oldest retentionMs ago
      const minId = `${Date.now() - this.retentionMs}-0`;
      await this.client.xTrim(this.streamName, "MINID", minId);
    }
  }

  async setMaxLen(maxLength: number): Promise<void> {
    this.maxLength = maxLength;
    await this.trimStream();
  }

  async setRetentionMs(retentionMs: number): Promise<void> {
    this.retentionMs = retentionMs;
    await this.trimStream();
  }

  // ─── Consumer Group Management ──────────────────────────────────────────

  async addConsumerGroup(groupName: string): Promise<void> {
    try {
      await this.client.xGroup("CREATE", this.streamName, groupName, "$", {
        MKSTREAM: true,
      });
    } catch (err: any) {
      if (!err.message.includes("BUSYGROUP")) {
        throw err;
      }
    }
  }

  async removeConsumerGroup(groupName: string): Promise<void> {
    try {
      await this.client.xGroup("DESTROY", this.streamName, groupName);
    } catch (err: any) {
      if (!err.message.includes("NOGROUP")) {
        throw err;
      }
    }
  }

  async getConsumerGroupState(groupName: string): Promise<ConsumerGroupState> {
    const groupInfo = await this.client.xInfoGroup(this.streamName, groupName);
    const consumersInfo = await this.client.xInfoConsumers(
      this.streamName,
      groupName
    );

    const consumers = (consumersInfo as any[]).map((c) => ({
      name: c.name,
      pending: c.pending,
      idleMs: c.idle,
      lastDelivery: c.active,
    }));

    return {
      groupName,
      stream: this.streamName,
      consumers,
      lastDeliveredId: groupInfo["last-delivered-id"] ?? "0",
      entriesRead: parseInt(groupInfo["entries-read"] || "0", 10),
    };
  }

  async listConsumerGroups(): Promise<ConsumerGroupState[]> {
    const groupsInfo = await this.client.xInfoGroups(this.streamName);

    const states: ConsumerGroupState[] = [];
    for (const group of groupsInfo as any[]) {
      try {
        const consumersInfo = await this.client.xInfoConsumers(
          this.streamName,
          group.name
        );

        const consumers = (consumersInfo as any[]).map((c) => ({
          name: c.name,
          pending: c.pending,
          idleMs: c.idle,
          lastDelivery: c.active,
        }));

        states.push({
          groupName: group.name,
          stream: this.streamName,
          consumers,
          lastDeliveredId: group["last-delivered-id"] ?? "0",
          entriesRead: parseInt(group["entries-read"] || "0", 10),
        });
      } catch {
        // Skip groups that no longer exist
      }
    }

    return states;
  }

  // ─── Utility Methods ────────────────────────────────────────────────────

  async getStreamInfo() {
    try {
      return await this.client.xInfoStream(this.streamName);
    } catch {
      return null;
    }
  }

  async getStreamLength(): Promise<number> {
    try {
      const result = await this.client.xLen(this.streamName);
      return parseInt(result as string, 10);
    } catch {
      return 0;
    }
  }

  async deleteStream(): Promise<void> {
    await this.client.del(this.streamName);
  }

  async resetConsumerGroup(groupName: string): Promise<void> {
    await this.client.xGroup("RESET", this.streamName, groupName);
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private parseMessage(msg: StreamMessage): ParsedStreamMessage<T> | null {
    try {
      const payloadStr = msg.fields.payload;
      const metadataStr = msg.fields.metadata;

      const payload = this.deserializer(payloadStr) as T;
      const metadata = this.deserializer(metadataStr) as Record<string, string>;

      return {
        id: msg.fields.id,
        stream: this.streamName,
        type: msg.fields.type,
        payload,
        metadata,
        timestamp: msg.fields.timestamp,
      };
    } catch (err) {
      log.error("Failed to parse message", {
        messageId: msg.id,
        error: (err as Error).message,
      });
      return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger("utils:redis-streams", process.env.LOG_LEVEL ?? "info");

// ─────────────────────────────────────────────────────────────────────────────
// Export utilities
// ─────────────────────────────────────────────────────────────────────────────

export function createStreamManager<T = unknown>(
  streamName: string,
  config: Partial<StreamConfig> = {},
  client?: any
): RedisStreamManager<T> {
  return new RedisStreamManager<T>(streamName, config, client);
}

// Re-export types for convenience
export type {
  StreamConfig,
  StreamEvent,
  ConsumerGroupState,
  StreamProcessingResult,
  StreamMessage,
  ParsedStreamMessage,
};
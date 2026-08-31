/**
 * Redis message broker bridge.
 *
 * Publishes `CDCDomainEvent`s to Redis:
 *
 *   - a **stream** `cdc:events` (XADD) for durable, replayable consumption by
 *     independent consumer groups, matching the `payments:events` precedent,
 *   - **pub/sub** on the per-table topic (`cdc:<schema>:<table>`) for real-time
 *     fan-out to subscribers, matching the notifications `notifications:*` pattern.
 *
 * Exactly-once is enforced upstream in the publisher (dedup + checkpoint), which
 * means this bridge only needs at-least-once delivery; ordering within a table is
 * preserved by the single WAL consumer.
 */

import { createRequire } from "node:module";
import { createLogger, type Logger } from "@delegolabs/utils";
import type { CDCDomainEvent } from "@delegolabs/types";
import type { MessageBroker } from "./publisher.js";

const STREAM_KEY = "cdc:events";

type RedisLike = {
  xadd(key: string, id: string, ...fieldValues: string[]): Promise<string | null>;
  publish(channel: string, message: string): Promise<number>;
  quit(): Promise<void>;
};

class InMemoryRedis implements RedisLike {
  private readonly streams = new Map<string, Array<{ id: string; fields: Record<string, string> }>>();
  private readonly subscribers = new Map<string, (channel: string, message: string) => void>();

  async xadd(key: string, _id: string, ...fieldValues: string[]): Promise<string> {
    const fields: Record<string, string> = {};
    for (let i = 0; i < fieldValues.length; i += 2) fields[fieldValues[i]] = fieldValues[i + 1];
    const entry = { id: `${Date.now()}-${Math.random()}`, fields };
    const list = this.streams.get(key) ?? [];
    list.push(entry);
    this.streams.set(key, list);
    return entry.id;
  }

  async publish(channel: string, message: string): Promise<number> {
    const handler = this.subscribers.get(channel);
    if (handler) handler(channel, message);
    return handler ? 1 : 0;
  }

  async quit(): Promise<void> {}

  // test helpers
  _streamLength(key: string): number {
    return (this.streams.get(key) ?? []).length;
  }
  _getStream(key: string): Array<{ id: string; fields: Record<string, string> }> {
    return this.streams.get(key) ?? [];
  }
  _subscribeForTest(channel: string, handler: (c: string, m: string) => void): void {
    this.subscribers.set(channel, handler);
  }
}

let _redis: RedisLike | null = null;

function makeInMemory(): InMemoryRedis {
  return new InMemoryRedis();
}

function getRedisClient(log: Logger): RedisLike {
  if (_redis) return _redis;

  const isTest = process.env.NODE_ENV === "test";
  const useMock = isTest || process.env.MOCK_REDIS === "true" || process.env.CI === "true";

  if (useMock) {
    log.info("Using in-memory Redis broker stub");
    _redis = makeInMemory();
  } else {
    const _require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Redis } = _require("ioredis") as any;
    _redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379") as unknown as RedisLike;
  }

  return _redis!;
}

export function _resetBrokerForTesting(): void {
  _redis = null;
}

export function _getBrokerClient(): RedisLike | null {
  return _redis;
}

export interface RedisBrokerOptions {
  log?: Logger;
  /** Serialize the event before XADD (default JSON). */
  serialize?: (event: CDCDomainEvent) => string;
}

export function createRedisBroker(options: RedisBrokerOptions = {}): MessageBroker {
  const log = options.log ?? createLogger("cdc:broker", process.env.LOG_LEVEL ?? "info");
  const serialize = options.serialize ?? ((event: CDCDomainEvent) => JSON.stringify(event));

  return {
    async publish(event: CDCDomainEvent): Promise<void> {
      const redis = getRedisClient(log);
      const serialized = serialize(event);

      // durable stream
      await redis.xadd(STREAM_KEY, "*", "data", serialized, "topic", event.topic, "op", event.op);
      // real-time fan-out
      await redis.publish(event.topic, serialized);
    },
  };
}

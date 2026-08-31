/**
 * Redis modules exports.
 *
 * - Issue #123: Redis Pub/Sub for real-time event broadcasting
 * - Issue #XXX: Redis Streams for event sourcing
 */

export { RedisPubSubManager, getRedisPubSubManager, resetRedisPubSubManager } from "./pubsub.js";
export type {
  PubSubChannel,
  PubSubMessage,
  PubSubSubscription,
  PubSubMetrics,
  PubSubHealth,
  PubSubConfig,
  DeadLetterMessage,
  MessageHandler,
  Serializer,
  SerializationFormat,
} from "./types.js";

export {
  RedisStreamManager,
  createStreamManager,
  type StreamConfig,
  type StreamEvent,
  type ConsumerGroupState,
  type StreamProcessingResult,
  type StreamMessage,
  type ParsedStreamMessage,
} from "./streams.js";

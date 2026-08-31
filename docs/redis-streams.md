# Redis Streams Event Sourcing

This document describes the Redis Streams implementation for event sourcing with consumer groups and exactly-once processing semantics.

## Overview

The Redis Streams implementation provides:

- **Event Log**: Persistent stream of events with configurable retention
- **Consumer Groups**: Horizontal scaling with multiple consumers per group
- **Exactly-Once Processing**: Pending entry tracking and claiming
- **Event Replay**: Replay events from any position in the stream
- **Stream Trimming**: Automatic cleanup to prevent OOM
- **Monitoring**: Per-stream and per-consumer-group metrics

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                            Redis Streams                            │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │ payment.stream│  │ order.stream │  │ fraud.stream│               │
│  └──────────────┘  └──────────────┘  └──────────────┘               │
│                           │                                          │
│                  ┌────────┴────────┐                                 │
│                  │  Consumer Groups│                                 │
│                  └────────┬────────┘                                 │
│        ┌──────────────────┼──────────────────┐                       │
│        │                  │                  │                       │
│  ┌─────▼─────┐    ┌───────▼───────┐  ┌──────▼───────┐               │
│  │payment-c1 │    │payment-c2     │  │fraud-c1      │               │
│  │payment-c2 │    │payment-c3     │  │fraud-c2      │               │
│  └───────────┘    └───────────────┘  └──────────────┘               │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

## Data Structures

### StreamConfig

```typescript
interface StreamConfig {
  streamName: string;
  maxLength: number;              // Maximum stream length
  trimStrategy: "maxlen" | "minid";
  retentionMs: number;            // Retention period in milliseconds
  consumerGroups: Array<{
    name: string;
    consumers: number;            // Expected consumer count for scaling
    claimMinIdleMs: number;       // Idle time before claiming pending entries
  }>;
}
```

### StreamEvent

```typescript
interface StreamEvent {
  id: string;                     // Redis stream ID
  stream: string;                 // Stream name
  type: string;                   // Event type
  payload: unknown;               // Event payload
  metadata: Record<string, string>;
  timestamp: string;              // ISO 8601 timestamp
}
```

### ConsumerGroupState

```typescript
interface ConsumerGroupState {
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
```

### StreamProcessingResult

```typescript
interface StreamProcessingResult {
  stream: string;
  groupName: string;
  consumerName: string;
  processed: number;
  failed: number;
  retried: number;
  avgProcessingMs: number;
  lag: number;
}
```

## API Reference

### RedisStreamManager

The main class for interacting with Redis Streams.

#### Constructor

```typescript
constructor(
  streamName: string,
  config?: Partial<StreamConfig>,
  client?: RedisClient
)
```

#### Methods

##### initialize()

Initializes the stream and consumer groups.

```typescript
await manager.initialize();
```

##### publish(type, payload, metadata?)

Publishes a single event to the stream.

```typescript
const id = await manager.publish(
  "payment.created",
  { amount: 100, currency: "USD" },
  { correlationId: "abc123" }
);
```

##### publishBatch(events)

Publishes multiple events in a batch.

```typescript
const ids = await manager.publishBatch([
  { type: "payment.created", payload: { amount: 100, currency: "USD" } },
  { type: "payment.completed", payload: { amount: 100, currency: "USD" } },
]);
```

##### processWithConsumerGroup(groupName, consumerName, handler, options?)

Processes events using a consumer group with exactly-once semantics.

```typescript
const result = await manager.processWithConsumerGroup(
  "payment-group",
  "consumer-1",
  async (event) => {
    // Process event
    await saveToDatabase(event.payload);
  },
  { batchSize: 10, blockMs: 5000 }
);

console.log(result.processed);  // Number of events processed
console.log(result.failed);     // Number of failed events
console.log(result.lag);        // Current stream lag
```

##### replayFrom(position, handler, options?)

Replays events from a specific position.

```typescript
// Replay from beginning
await manager.replayFrom("0", async (event) => {
  console.log(event.type, event.payload);
  return true;  // Continue replay
});

// Replay from specific ID
await manager.replayFrom("1690000000-0", async (event) => {
  console.log(event.id, event.payload);
  return true;
});
```

##### replayAll(handler, options?)

Replays all events from the beginning.

```typescript
await manager.replayAll(async (event) => {
  console.log(event.type, event.payload);
  return true;
});
```

##### replayLast(handler, options?)

Replays the most recent events.

```typescript
await manager.replayLast(async (event) => {
  console.log(event.type, event.payload);
  return true;
});
```

##### getConsumerGroupState(groupName)

Gets the state of a consumer group.

```typescript
const state = await manager.getConsumerGroupState("payment-group");
console.log(state.consumers);
console.log(state.entriesRead);
```

##### listConsumerGroups()

Lists all consumer groups for the stream.

```typescript
const groups = await manager.listConsumerGroups();
```

##### addConsumerGroup(groupName)

Adds a new consumer group.

```typescript
await manager.addConsumerGroup("new-group");
```

##### removeConsumerGroup(groupName)

Removes a consumer group.

```typescript
await manager.removeConsumerGroup("old-group");
```

##### trimStream()

Trims the stream to prevent OOM.

```typescript
await manager.trimStream();
```

##### setMaxLen(maxLength)

Sets the maximum stream length.

```typescript
await manager.setMaxLen(5000);
```

##### setRetentionMs(retentionMs)

Sets the retention period.

```typescript
await manager.setRetentionMs(48 * 60 * 60 * 1000);  // 48 hours
```

##### getStreamInfo()

Gets stream information.

```typescript
const info = await manager.getStreamInfo();
console.log(info.length);
console.log(info.groups);
```

##### getStreamLength()

Gets the current stream length.

```typescript
const length = await manager.getStreamLength();
```

##### deleteStream()

Deletes the stream.

```typescript
await manager.deleteStream();
```

##### resetConsumerGroup(groupName)

Resets a consumer group to start from the latest message.

```typescript
await manager.resetConsumerGroup("payment-group");
```

## Usage Examples

### Payment Event Processing

```typescript
import { RedisStreamManager } from "@delegolabs/utils";

// Create stream manager
const paymentManager = new RedisStreamManager("payment-events", {
  maxLength: 10000,
  trimStrategy: "maxlen",
  retentionMs: 24 * 60 * 60 * 1000,
  consumerGroups: [
    { name: "notification-group", consumers: 2, claimMinIdleMs: 30000 },
    { name: "ledger-group", consumers: 3, claimMinIdleMs: 10000 },
  ],
});

// Initialize
await paymentManager.initialize();

// Publish payment events
await paymentManager.publish("payment.created", {
  id: "pay_123",
  amount: 10000,
  currency: "USD",
  payer: "user_456",
  payee: "merchant_789",
});

// Consumer: Notification Service
await paymentManager.processWithConsumerGroup(
  "notification-group",
  "notification-service-1",
  async (event) => {
    if (event.type === "payment.created") {
      await sendNotification(event.payload);
    }
  }
);

// Consumer: Ledger Service
await paymentManager.processWithConsumerGroup(
  "ledger-group",
  "ledger-service-1",
  async (event) => {
    if (event.type === "payment.created") {
      await updateLedger(event.payload);
    }
  }
);
```

### Fraud Detection with Replay

```typescript
const fraudManager = new RedisStreamManager("fraud-events", {
  maxLength: 50000,
  trimStrategy: "maxlen",
  retentionMs: 7 * 24 * 60 * 60 * 1000,  // 7 days
  consumerGroups: [
    { name: "realtime-group", consumers: 4, claimMinIdleMs: 5000 },
    { name: "batch-group", consumers: 1, claimMinIdleMs: 300000 },
  ],
});

await fraudManager.initialize();

// Replays fraud events for model training
await fraudManager.replayFrom("1690000000-0", async (event) => {
  if (event.type === "transaction.flagged") {
    await saveForAnalysis(event.payload);
  }
  return true;
});

// Real-time fraud detection
await fraudManager.processWithConsumerGroup(
  "realtime-group",
  "fraud-detector-1",
  async (event) => {
    if (event.type === "transaction.initiated") {
      const riskScore = await calculateRiskScore(event.payload);
      if (riskScore > 0.8) {
        await flagForReview(event.payload);
      }
    }
  }
);
```

### Event Schema Evolution

```typescript
// Version 1: Basic payment
const v1Manager = new RedisStreamManager("payments", {
  maxLength: 10000,
  consumerGroups: [{ name: "v1-group", consumers: 1, claimMinIdleMs: 30000 }],
});

await v1Manager.initialize();

// Publish v1 event
await v1Manager.publish("payment.created", {
  id: "pay_123",
  amount: 10000,
  currency: "USD",
});

// Version 2: Add fee information
const v2Manager = new RedisStreamManager("payments", {
  maxLength: 10000,
  consumerGroups: [{ name: "v2-group", consumers: 1, claimMinIdleMs: 30000 }],
});

await v2Manager.initialize();

// Replay and transform events
await v2Manager.replayAll(async (event) => {
  const updatedPayload = {
    ...event.payload,
    fee: Math.round(event.payload.amount * 0.02),  // 2% fee
  };
  await v2Manager.publish(event.type, updatedPayload);
});

// New consumers read both v1 and v2 events
await v2Manager.processWithConsumerGroup(
  "v2-group",
  "consumer-1",
  async (event) => {
    // Handle both v1 and v2 payloads
    const payload = event.payload as any;
    if (!payload.fee) {
      payload.fee = Math.round(payload.amount * 0.02);
    }
    // Process...
  }
);
```

## Exactly-Once Processing

The implementation ensures exactly-once processing through:

1. **Pending Entry Tracking**: Redis tracks entries delivered to consumers but not yet ACK'd
2. **Claim Idle Entries**: On startup, claim entries that have been idle beyond `claimMinIdleMs`
3. **ACK after Processing**: Only acknowledge after successful processing
4. **Retry Count**: Track delivery count for messages that fail repeatedly

```typescript
// Example with retry logic
await manager.processWithConsumerGroup(
  "payment-group",
  "consumer-1",
  async (event) => {
    try {
      await processPayment(event.payload);
      // ACK happens automatically on success
    } catch (error) {
      // Message stays pending for retry
      // Delivery count increments
      throw error;
    }
  }
);
```

## Stream Trimming

Streams are automatically trimmed to prevent OOM:

```typescript
// Max length trimming
const manager = new RedisStreamManager("events", {
  maxLength: 10000,
  trimStrategy: "maxlen",
});

// Min ID trimming by retention
const manager = new RedisStreamManager("events", {
  maxLength: 100000,
  trimStrategy: "minid",
  retentionMs: 24 * 60 * 60 * 1000,  // Keep last 24 hours
});
```

## Monitoring

Monitor consumer group lag and health:

```typescript
const state = await manager.getConsumerGroupState("payment-group");
console.log("Consumers:", state.consumers.length);
console.log("Pending:", state.consumers.reduce((sum, c) => sum + c.pending, 0));
console.log("Entries Read:", state.entriesRead);

// Calculate lag
const info = await manager.getStreamInfo();
const lag = info?.length - state.entriesRead || 0;
console.log("Lag:", lag);
```

## Testing

Run tests with:

```bash
pnpm test packages/utils/src/redis/streams.test.ts
```

Run with coverage:

```bash
pnpm test:coverage packages/utils/src/redis/streams.test.ts
```

## Performance Considerations

1. **Batch Processing**: Use `publishBatch` for high-throughput scenarios
2. **Consumer Count**: Scale consumers within a group (not across groups)
3. **Block Time**: Set `blockMs` appropriately for your latency requirements
4. **Stream Length**: Set `maxLength` based on your storage capacity
5. **Retention**: Use `minid` strategy for time-based retention

## Migration

To migrate from another event sourcing solution:

```typescript
// Read from source
const sourceEvents = await readFromSource();

// Publish to Redis Streams
for (const event of sourceEvents) {
  await manager.publish(event.type, event.payload, event.metadata);
}

// Verify
const count = await manager.replayAll(async () => 1);
console.log("Migrated", count, "events");
```
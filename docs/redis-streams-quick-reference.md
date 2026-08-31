# Redis Streams Quick Reference

## Installation

```bash
pnpm add ioredis
```

## Basic Usage

```typescript
import { RedisStreamManager } from "@delegolabs/utils";
import { Redis } from "ioredis";

const client = new Redis("redis://localhost:6379");
const manager = new RedisStreamManager("events", {
  maxLength: 10000,
  trimStrategy: "maxlen",
  consumerGroups: [
    { name: "my-group", consumers: 2, claimMinIdleMs: 30000 },
  ],
}, client);

await manager.initialize();
```

## Publishing Events

| Method | Description |
|--------|-------------|
| `publish(type, payload, metadata?)` | Publish single event |
| `publishBatch(events)` | Publish multiple events |

```typescript
// Single event
await manager.publish("payment.created", {
  paymentId: "pay_123",
  amount: 10000,
});

// Batch events
await manager.publishBatch([
  { type: "payment.created", payload: { paymentId: "pay_1" } },
  { type: "payment.completed", payload: { paymentId: "pay_1" } },
]);
```

## Processing Events

| Method | Description |
|--------|-------------|
| `processWithConsumerGroup(group, consumer, handler, options?)` | Process with exactly-once |

```typescript
await manager.processWithConsumerGroup(
  "my-group",
  "consumer-1",
  async (event) => {
    console.log(event.type, event.payload);
    // Process event
  },
  { batchSize: 10, blockMs: 5000 }
);
```

## Event Replay

| Method | Description |
|--------|-------------|
| `replayAll(handler, options?)` | Replay all events |
| `replayLast(handler, options?)` | Replay from end |
| `replayFrom(position, handler, options?)` | Replay from position |

```typescript
// Replay all
await manager.replayAll(async (event) => {
  console.log(event.payload);
  return true; // Continue
});

// Replay from position
await manager.replayFrom("1690000000-0", async (event) => {
  console.log(event.payload);
  return true;
});
```

## Consumer Group Management

| Method | Description |
|--------|-------------|
| `getConsumerGroupState(group)` | Get group state |
| `listConsumerGroups()` | List all groups |
| `addConsumerGroup(group)` | Add group |
| `removeConsumerGroup(group)` | Remove group |
| `resetConsumerGroup(group)` | Reset group |

```typescript
const state = await manager.getConsumerGroupState("my-group");
console.log(state.consumers, state.entriesRead);

const groups = await manager.listConsumerGroups();
```

## Stream Management

| Method | Description |
|--------|-------------|
| `trimStream()` | Trim stream |
| `setMaxLen(max)` | Set max length |
| `setRetentionMs(ms)` | Set retention |
| `getStreamInfo()` | Get stream info |
| `getStreamLength()` | Get length |
| `deleteStream()` | Delete stream |

```typescript
await manager.trimStream();
await manager.setMaxLen(5000);
await manager.setRetentionMs(24 * 60 * 60 * 1000);

const info = await manager.getStreamInfo();
console.log(info.length, info.groups);
```

## Data Structures

### StreamConfig
```typescript
interface StreamConfig {
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
```

### StreamEvent
```typescript
interface StreamEvent {
  id: string;
  stream: string;
  type: string;
  payload: unknown;
  metadata: Record<string, string>;
  timestamp: string;
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

## Consumer Group Rebalancing

Consumer groups automatically rebalance when:
- New consumers join the group
- Existing consumers leave
- Consumers become idle beyond `claimMinIdleMs`

The `processWithConsumerGroup` method:
1. Claims idle pending entries before processing new messages
2. Automatically handles consumer failover
3. Tracks delivery counts for retry logic

```typescript
// Example: Rebalancing scenario
const group = "payment-group";
const consumers = ["c1", "c2", "c3", "c4"];

// Each consumer processes independently
await Promise.all(consumers.map(c => 
  manager.processWithConsumerGroup(group, c, handler)
));
```

## Error Handling

```typescript
await manager.processWithConsumerGroup(
  "my-group",
  "consumer-1",
  async (event) => {
    try {
      await process(event.payload);
      // ACK happens automatically on success
    } catch (error) {
      // Message stays pending for retry
      // Delivery count increments
      throw error;
    }
  }
);
```

## Monitoring

```typescript
const state = await manager.getConsumerGroupState("my-group");

// Check lag
const info = await manager.getStreamInfo();
const lag = info?.length - state.entriesRead || 0;

// Check consumer health
for (const consumer of state.consumers) {
  console.log(`${consumer.name}: ${consumer.pending} pending, ${consumer.idleMs}ms idle`);
}
```
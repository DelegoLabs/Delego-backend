# @delegolabs/utils

Shared utilities: logging, currency conversion, ID generation, API boundary parsers, Redis integration, and more.

## Parsers (Issues #218, #219)

- `parseBigIntString(input, options?)` — validates bigint-safe amount strings for gateway, wallet, and payments services. Rejects decimals, non-string inputs, and optionally negatives or values above `max`.
- `parseIsoDate(input, options?)` — validates strict ISO-8601 date-time strings for auth, delegation, and workflow APIs. Supports `rejectFuture` and `rejectPast` options.

## Redis Integration (Issue #XXX)

### Redis Streams (Event Sourcing)

Real-time event sourcing with consumer groups and exactly-once processing semantics.

**Features:**
- Persistent event streams with configurable retention
- Consumer groups for horizontal scaling
- Exactly-once processing via pending entries and claiming
- Event replay from any position
- Automatic stream trimming to prevent OOM
- Processing metrics and lag monitoring
- Consumer group rebalancing support

**Usage:**

```typescript
import { RedisStreamManager } from "@delegolabs/utils";
import { Redis } from "ioredis";

const client = new Redis("redis://localhost:6379");
const manager = new RedisStreamManager("events", {
  maxLength: 10000,
  trimStrategy: "maxlen",
  consumerGroups: [
    { name: "my-group", consumers: 3, claimMinIdleMs: 30000 },
  ],
});

await manager.initialize();

// Publish events
await manager.publish("payment.created", { amount: 100, currency: "USD" });

// Process with consumer group
await manager.processWithConsumerGroup(
  "my-group",
  "consumer-1",
  async (event) => {
    console.log(event.type, event.payload);
  }
);

// Replay events
await manager.replayAll(async (event) => {
  console.log(event.type, event.payload);
  return true;
});
```

**API:**

- `initialize()` — Create stream and consumer groups
- `publish(type, payload, metadata?)` — Single event
- `publishBatch(events)` — Batch events
- `processWithConsumerGroup(group, consumer, handler, options?)` — Process with exactly-once
- `replayFrom(position, handler, options?)` — Replay from position
- `replayAll(handler, options?)` — Replay all events
- `getConsumerGroupState(group)` — Get group state
- `listConsumerGroups()` — List all groups
- `addConsumerGroup(group)` — Add group
- `removeConsumerGroup(group)` — Remove group
- `trimStream()` — Trim stream
- `getStreamInfo()` — Stream statistics
- `deleteStream()` — Delete stream

See `docs/redis-streams.md` for detailed documentation.

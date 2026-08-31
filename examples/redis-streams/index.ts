/**
 * Redis Streams Event Sourcing Example
 *
 * Demonstrates:
 *   - Creating and initializing a stream
 *   - Publishing events
 *   - Consumer group processing with exactly-once semantics
 *   - Event replay
 *   - Stream management
 */

import { Redis } from "ioredis";
import { RedisStreamManager } from "../packages/utils/src/redis/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

interface PaymentEvent {
  paymentId: string;
  amount: number;
  currency: string;
  payer: string;
  payee: string;
  status: "pending" | "completed" | "failed";
}

interface FraudEvent {
  transactionId: string;
  riskScore: number;
  flags: string[];
  action: "allow" | "review" | "block";
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment Service Example
// ─────────────────────────────────────────────────────────────────────────────

async function paymentServiceExample() {
  const redis = new Redis("redis://localhost:6379");
  
  // Create stream manager for payment events
  const paymentManager = new RedisStreamManager<PaymentEvent>(
    "payment-events",
    {
      maxLength: 10000,
      trimStrategy: "maxlen",
      retentionMs: 24 * 60 * 60 * 1000,
      consumerGroups: [
        { name: "notification-group", consumers: 2, claimMinIdleMs: 30000 },
        { name: "ledger-group", consumers: 3, claimMinIdleMs: 10000 },
        { name: "analytics-group", consumers: 1, claimMinIdleMs: 5000 },
      ],
    },
    redis
  );

  // Initialize stream and consumer groups
  await paymentManager.initialize();
  console.log("Payment stream initialized");

  // Publish payment events
  const paymentId = await paymentManager.publish("payment.created", {
    paymentId: "pay_123",
    amount: 10000,
    currency: "USD",
    payer: "user_456",
    payee: "merchant_789",
    status: "pending",
  });

  console.log(`Published payment created: ${paymentId}`);

  await paymentManager.publish("payment.completed", {
    paymentId: "pay_123",
    amount: 10000,
    currency: "USD",
    payer: "user_456",
    payee: "merchant_789",
    status: "completed",
  });

  console.log("Published payment completed");

  // ─── Consumer: Notification Service ─────────────────────────────────────

  await paymentManager.processWithConsumerGroup(
    "notification-group",
    "notification-service-1",
    async (event) => {
      console.log("[Notification] Processing:", event.type);

      if (event.type === "payment.created") {
        console.log("  -> Sending notification to payer");
      } else if (event.type === "payment.completed") {
        console.log("  -> Sending notification to both parties");
      }
    }
  );

  // ─── Consumer: Ledger Service ───────────────────────────────────────────

  await paymentManager.processWithConsumerGroup(
    "ledger-group",
    "ledger-service-1",
    async (event) => {
      console.log("[Ledger] Processing:", event.type);

      if (event.type === "payment.completed") {
        console.log("  -> Updating ledger entries");
      }
    }
  );

  // ─── Consumer: Analytics Service ────────────────────────────────────────

  await paymentManager.processWithConsumerGroup(
    "analytics-group",
    "analytics-service-1",
    async (event) => {
      console.log("[Analytics] Processing:", event.type);

      if (event.type === "payment.completed") {
        console.log("  -> Recording analytics event");
      }
    }
  );

  // ─── Event Replay Example ───────────────────────────────────────────────

  console.log("\n=== Replaying All Events ===");
  await paymentManager.replayAll(async (event) => {
    console.log(`Replayed: ${event.type}`, event.payload);
    return true;
  });

  // ─── Stream State Monitoring ────────────────────────────────────────────

  console.log("\n=== Stream State ===");
  const info = await paymentManager.getStreamInfo();
  console.log("Stream length:", info?.length);
  console.log("Consumer groups:", info?.groups);

  console.log("\n=== Consumer Group States ===");
  const groups = await paymentManager.listConsumerGroups();
  for (const group of groups) {
    console.log(`\nGroup: ${group.groupName}`);
    console.log("  Consumers:", group.consumers.length);
    console.log("  Total Pending:", group.consumers.reduce((sum, c) => sum + c.pending, 0));
    console.log("  Entries Read:", group.entriesRead);
  }

  // Cleanup
  await paymentManager.deleteStream();
  await redis.quit();
}

// ─────────────────────────────────────────────────────────────────────────────
// Fraud Detection Example
// ─────────────────────────────────────────────────────────────────────────────

async function fraudDetectionExample() {
  const redis = new Redis("redis://localhost:6379");

  const fraudManager = new RedisStreamManager<FraudEvent>(
    "fraud-events",
    {
      maxLength: 50000,
      trimStrategy: "maxlen",
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      consumerGroups: [
        { name: "realtime-group", consumers: 4, claimMinIdleMs: 5000 },
        { name: "batch-group", consumers: 1, claimMinIdleMs: 300000 },
        { name: "training-group", consumers: 2, claimMinIdleMs: 60000 },
      ],
    },
    redis
  );

  await fraudManager.initialize();
  console.log("Fraud stream initialized");

  // Simulate transaction events
  const transactions = Array.from({ length: 100 }, (_, i) => ({
    type: "transaction.flagged",
    payload: {
      transactionId: `txn_${i}`,
      riskScore: Math.random(),
      flags: Math.random() > 0.8 ? ["high_amount", "unusual_location"] : [],
      action: Math.random() > 0.9 ? "block" : "allow",
    } satisfies FraudEvent,
  }));

  // Publish in batch
  const ids = await fraudManager.publishBatch(transactions);
  console.log(`Published ${ids.length} fraud events`);

  // Process with multiple consumers (simulating horizontal scaling)
  const processWithConsumer = async (consumerId: string) => {
    await fraudManager.processWithConsumerGroup(
      "realtime-group",
      consumerId,
      async (event) => {
        console.log(`[${consumerId}] Processing: ${event.type}`);
        
        if (event.payload.riskScore > 0.8) {
          console.log(`  -> HIGH RISK: ${event.payload.riskScore}`);
        }
      }
    );
  };

  // Start 4 consumers
  await Promise.all([
    processWithConsumer("fraud-detector-1"),
    processWithConsumer("fraud-detector-2"),
    processWithConsumer("fraud-detector-3"),
    processWithConsumer("fraud-detector-4"),
  ]);

  // Replay for model training
  console.log("\n=== Model Training Replay ===");
  let trainedCount = 0;
  await fraudManager.replayFrom("0", async (event) => {
    if (event.type === "transaction.flagged") {
      trainedCount++;
    }
    return true;
  });
  console.log(`Trained on ${trainedCount} events`);

  await fraudManager.deleteStream();
  await redis.quit();
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema Evolution Example
// ─────────────────────────────────────────────────────────────────────────────

async function schemaEvolutionExample() {
  const redis = new Redis("redis://localhost:6379");

  // Version 1: Basic payment
  const v1Manager = new RedisStreamManager<{
    paymentId: string;
    amount: number;
    currency: string;
  }>("v1-payments", {
    maxLength: 1000,
    consumerGroups: [{ name: "v1-group", consumers: 1, claimMinIdleMs: 30000 }],
  }, redis);

  await v1Manager.initialize();

  // Publish v1 events
  await v1Manager.publish("payment.created", {
    paymentId: "pay_v1_1",
    amount: 10000,
    currency: "USD",
  });

  // Version 2: Add fee
  const v2Manager = new RedisStreamManager<{
    paymentId: string;
    amount: number;
    currency: string;
    fee: number;
  }>("v2-payments", {
    maxLength: 1000,
    consumerGroups: [{ name: "v2-group", consumers: 1, claimMinIdleMs: 30000 }],
  }, redis);

  await v2Manager.initialize();

  // Migrate: replay and transform
  console.log("Migrating schema...");
  await v1Manager.replayAll(async (event) => {
    const v2Payload = {
      ...event.payload,
      fee: Math.round(event.payload.amount * 0.02),
    };
    await v2Manager.publish(event.type, v2Payload);
    console.log("Migrated:", event.payload.paymentId);
  });

  // New consumers can read v2 events
  console.log("\n=== Reading v2 Events ===");
  await v2Manager.replayAll(async (event) => {
    console.log(event.payload);
    return true;
  });

  await v1Manager.deleteStream();
  await v2Manager.deleteStream();
  await redis.quit();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Redis Streams Examples ===\n");

  try {
    // Uncomment to run examples
    // await paymentServiceExample();
    // await fraudDetectionExample();
    // await schemaEvolutionExample();

    console.log("Examples ready to run. Uncomment in main() to execute.");
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
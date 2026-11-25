/**
 * BullMQ worker for chat archival jobs.
 */
import { Worker, Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { createLogger } from "@delegolabs/utils";
import type { ChatArchivalJobData, ChatArchivalJobResult } from "./types.js";
import type { ChatArchivalService } from "./service.js";
import type { DatabaseService } from "./database.js";

const log = createLogger("chat-archival:worker", process.env.LOG_LEVEL ?? "info");

export const CHAT_ARCHIVAL_QUEUE_NAME = "chat-archival";

export interface ChatArchivalWorkerConfig {
  redisUrl?: string;
  concurrency?: number;
  olderThanDays?: number;
  batchSize?: number;
  dryRun?: boolean;
}

export class ChatArchivalWorker {
  private worker: Worker<ChatArchivalJobData, ChatArchivalJobResult>;
  private queue: Queue<ChatArchivalJobData>;
  private queueEvents: QueueEvents;
  private connection: Redis;

  constructor(
    private readonly service: ChatArchivalService & { database: DatabaseService },
    config: ChatArchivalWorkerConfig = {},
  ) {
    const redisUrl = config.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6379";
    this.connection = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
    });

    this.queue = new Queue(CHAT_ARCHIVAL_QUEUE_NAME, {
      connection: this.connection,
    });

    this.worker = new Worker<ChatArchivalJobData, ChatArchivalJobResult>(
      CHAT_ARCHIVAL_QUEUE_NAME,
      async (job) => {
        const { sessionId, dryRun } = job.data;
        log.info("Processing chat archival job", { jobId: job.id, sessionId, dryRun });
        
        const result = await this.service.archiveSession(sessionId, dryRun ?? config.dryRun ?? false);
        
        if (!result.success) {
          throw new Error(result.error ?? "Archival failed");
        }
        
        return result;
      },
      {
        connection: this.connection,
        concurrency: config.concurrency ?? 5,
      }
    );

    this.queueEvents = new QueueEvents(CHAT_ARCHIVAL_QUEUE_NAME, {
      connection: this.connection,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.worker.on("completed", (job, result) => {
      log.info("Chat archival job completed", {
        jobId: job.id,
        sessionId: job.data.sessionId,
        messageCount: result.messageCount,
      });
    });

    this.worker.on("failed", (job, err) => {
      log.error("Chat archival job failed", {
        jobId: job?.id,
        sessionId: job?.data.sessionId,
        error: err.message,
      });
    });

    this.worker.on("error", (err) => {
      log.error("Chat archival worker error", { error: err.message });
    });
  }

  async scheduleBatchArchival(
    olderThanDays: number,
    batchSize: number,
    dryRun = false,
  ): Promise<void> {
    log.info("Scheduling batch chat archival", { olderThanDays, batchSize, dryRun });

    // Find idle sessions and queue individual jobs
    const idleSessions = await this.service.database.findIdleSessions(olderThanDays, batchSize);
    
    for (const session of idleSessions) {
      await this.queue.add(
        "archive-session",
        { sessionId: session.session_id, dryRun },
        {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        }
      );
    }

    log.info("Scheduled batch archival jobs", { count: idleSessions.length });
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
    await this.queueEvents.close();
    await this.connection.quit();
  }
}

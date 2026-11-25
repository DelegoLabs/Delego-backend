import { Worker, type Job } from "bullmq";
import { createLogger } from "@delegolabs/utils";
import { sendEmail, type EmailMessage } from "../email/index.js";
import { broadcastNotificationToUser } from "./websocket.js";
import { createNotification, type NotificationDb } from "./notificationStore.js";
import { sequelize } from "./db.js";
import { redisConnectionFromUrl } from "./restock/queue.js";

const log = createLogger("notifications:arbiter", process.env.LOG_LEVEL ?? "info");

export const ARBITER_NOTIFICATION_QUEUE = "arbiter-notifications";
export const ARBITER_NOTIFICATION_JOB = "dispute-raised";

export interface ArbiterDisputeNotificationJobData {
  event: "dispute.raised";
  audience: "arbiters";
  orderId: string;
  disputeId: string;
  initiatorAddress: string;
  disputeReasonCode: number;
  evidenceHash: string;
  evidenceUrl: string;
  ledgerSequence: number;
  occurredAt: string;
}

export interface ArbiterNotificationDeps {
  emails?: string[];
  userIds?: string[];
  sendEmail?: (message: EmailMessage) => Promise<void>;
  broadcast?: (
    userId: string,
    event: { type: string; payload: Record<string, unknown> },
  ) => void;
  createInAppNotification?: (
    input: Parameters<typeof createNotification>[1],
  ) => Promise<unknown>;
}

export interface ArbiterNotificationResult {
  emailsSent: number;
  emailsFailed: number;
  inAppCreated: number;
  websocketBroadcasts: number;
}

const notificationDb: NotificationDb = {
  async query(text: string, params: unknown[]) {
    const [rows, metadata] = await sequelize.query(text, { bind: params });
    const result = metadata as { rowCount?: number };
    return { rows: rows as unknown[], rowCount: result.rowCount };
  },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildArbiterEmail(data: ArbiterDisputeNotificationJobData): EmailMessage {
  const subject = `Dispute raised for order ${data.orderId}`;
  const text = [
    "A buyer raised a dispute on-chain.",
    `Order: ${data.orderId}`,
    `Dispute: ${data.disputeId}`,
    `Initiator: ${data.initiatorAddress}`,
    `Reason code: ${data.disputeReasonCode}`,
    `Evidence hash: ${data.evidenceHash}`,
    `Evidence: ${data.evidenceUrl}`,
    `Ledger sequence: ${data.ledgerSequence}`,
    `Occurred at: ${data.occurredAt}`,
  ].join("\n");
  const html = `
    <h1>Dispute raised</h1>
    <p>A buyer raised a dispute on-chain. Automated settlement has been frozen.</p>
    <ul>
      <li><strong>Order:</strong> ${escapeHtml(data.orderId)}</li>
      <li><strong>Dispute:</strong> ${escapeHtml(data.disputeId)}</li>
      <li><strong>Initiator:</strong> ${escapeHtml(data.initiatorAddress)}</li>
      <li><strong>Reason code:</strong> ${escapeHtml(String(data.disputeReasonCode))}</li>
      <li><strong>Evidence hash:</strong> ${escapeHtml(data.evidenceHash)}</li>
      <li><strong>Ledger sequence:</strong> ${escapeHtml(String(data.ledgerSequence))}</li>
    </ul>
    <p><a href="${escapeHtml(data.evidenceUrl)}">Open evidence file</a></p>
  `;
  return { to: "", subject, html, text };
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function processArbiterNotificationJob(
  data: ArbiterDisputeNotificationJobData,
  deps: ArbiterNotificationDeps = {},
): Promise<ArbiterNotificationResult> {
  const emails = deps.emails ?? parseList(process.env.ARBITER_ALERT_EMAILS ?? process.env.DISPUTE_ARBITER_EMAILS);
  const userIds = deps.userIds ?? parseList(process.env.ARBITER_USER_IDS);
  const send = deps.sendEmail ?? sendEmail;
  const broadcast = deps.broadcast ?? broadcastNotificationToUser;
  const createInApp =
    deps.createInAppNotification ??
    ((input: Parameters<typeof createNotification>[1]) =>
      createNotification(notificationDb, input));

  const result: ArbiterNotificationResult = {
    emailsSent: 0,
    emailsFailed: 0,
    inAppCreated: 0,
    websocketBroadcasts: 0,
  };

  for (const email of emails) {
    const message = buildArbiterEmail(data);
    message.to = email;
    try {
      await send(message);
      result.emailsSent += 1;
    } catch (error) {
      result.emailsFailed += 1;
      log.error("Failed to send arbiter dispute email", {
        disputeId: data.disputeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const userId of userIds) {
    try {
      await createInApp({
        userId,
        category: "system",
        type: "dispute.raised",
        title: "Dispute raised",
        message: `Order ${data.orderId} was disputed on-chain. Automated settlement is frozen.`,
        actionUrl: data.evidenceUrl,
        actionLabel: "View evidence",
        metadata: { ...data },
      });
      result.inAppCreated += 1;
    } catch (error) {
      log.error("Failed to create arbiter in-app notification", {
        userId,
        disputeId: data.disputeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      broadcast(userId, {
        type: "dispute.raised",
        payload: { ...data },
      });
      result.websocketBroadcasts += 1;
    } catch (error) {
      log.error("Failed to broadcast arbiter dispute notification", {
        userId,
        disputeId: data.disputeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (emails.length === 0 && userIds.length === 0) {
    log.warn("No arbiter notification recipients configured", {
      disputeId: data.disputeId,
      orderId: data.orderId,
    });
  }

  return result;
}

export interface ArbiterNotificationWorkerHandle {
  close(): Promise<void>;
}

export function startArbiterNotificationWorker(): ArbiterNotificationWorkerHandle {
  const worker = new Worker<ArbiterDisputeNotificationJobData, ArbiterNotificationResult>(
    ARBITER_NOTIFICATION_QUEUE,
    async (job: Job<ArbiterDisputeNotificationJobData>) => {
      if (job.name !== ARBITER_NOTIFICATION_JOB) {
        return { emailsSent: 0, emailsFailed: 0, inAppCreated: 0, websocketBroadcasts: 0 };
      }
      const result = await processArbiterNotificationJob(job.data);
      log.info("Processed arbiter dispute notification", {
        jobId: job.id,
        disputeId: job.data.disputeId,
        ...result,
      });
      return result;
    },
    {
      connection: redisConnectionFromUrl(),
      concurrency: Number(process.env.ARBITER_WORKER_CONCURRENCY ?? 2),
    },
  );

  worker.on("failed", (job, err) => {
    log.error("Arbiter notification job failed", {
      jobId: job?.id,
      disputeId: job?.data.disputeId,
      attempt: job?.attemptsMade,
      error: err.message,
    });
  });

  log.info("Arbiter notification worker started", { queue: ARBITER_NOTIFICATION_QUEUE });

  return {
    async close() {
      await worker.close();
    },
  };
}

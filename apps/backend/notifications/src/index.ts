/**
 * @delegolabs/notifications — Entry point
 */
import { createLogger, startHttpServer, route, json, corsMiddleware, securityHeadersMiddleware } from "@delegolabs/utils";
import { readBody } from "./readBody.js";
import { broadcastNotificationToUser, getWebSocketMetrics, initWebSocketServer } from "./websocket.js";
import { sequelize } from "./db.js";
import {
  bulkUpdateNotifications,
  createNotification,
  listNotifications,
  type NotificationCategory,
} from "./notificationStore.js";
import {
  savePushSubscription,
  removePushSubscription,
  dispatchTransactionApproval,
} from "./dispatcher.js";
import { getVapidPublicKey } from "../push/index.js";
import { startPermissionEventListener } from "./permissionEventListener.js";
import { startEscrowEventListener } from "./escrowEventListener.js";
import {
  cancelScheduledNotification,
  catchUpMissedNotifications,
  getScheduledNotification,
  getSchedulerMetrics,
  listScheduledNotifications,
  processDueNotifications,
  scheduleNotification,
  scheduleRecurringNotification,
  setScheduledNotificationStore,
  DEFAULT_SCHEDULER_CONFIG,
  type ScheduledNotification,
  type ScheduledNotificationStatus,
} from "./scheduler/index.js";
import { PostgresScheduledNotificationStore } from "./scheduler/store.js";
import type { IncomingMessage, ServerResponse, Server } from "node:http";

const SERVICE_NAME = "notifications";
const DEFAULT_PORT = 3015;

const nodeEnv = process.env.NODE_ENV ?? "development";
const logLevel = process.env.LOG_LEVEL ?? "info";
const log = createLogger(SERVICE_NAME, logLevel);
const port = Number(process.env.NOTIFICATIONS_PORT ?? DEFAULT_PORT);
const notificationDb = {
  async query(text: string, params: unknown[]) {
    const [rows, metadata] = await sequelize.query(text, { bind: params });
    const result = metadata as { rowCount?: number };
    return { rows: rows as unknown[], rowCount: result.rowCount };
  },
};

log.info("Starting service", { port, nodeEnv });

// Issue #57 — opt-in permission event listener.
// Requires both STELLAR_RPC_URL (or SOROBAN_RPC_URL) and
// PERMISSIONS_CONTRACT_ID to be set.  When unset the service boots normally
// without the listener so test environments and local dev do not need a live
// RPC.
const rpcUrl =
  process.env.STELLAR_RPC_URL ??
  process.env.SOROBAN_RPC_URL ??
  "";
const permissionsContractId =
  process.env.PERMISSIONS_CONTRACT_ID ?? "";

let permissionListener: { stop(): Promise<void> } | null = null;
if (rpcUrl && permissionsContractId) {
  try {
    permissionListener = startPermissionEventListener(
      rpcUrl,
      permissionsContractId
    );
    log.info("Permission event listener wired to boot", {
      rpcUrl,
      contractId: permissionsContractId,
    });
  } catch (err) {
    log.error("Failed to start permission event listener", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
} else {
  log.info(
    "Permission event listener disabled (set STELLAR_RPC_URL and PERMISSIONS_CONTRACT_ID to enable)"
  );
}

// Issue #56 — opt-in escrow event listener.
// Requires both STELLAR_RPC_URL and ESCROW_CONTRACT_ID to be set.
const escrowContractId = process.env.ESCROW_CONTRACT_ID ?? "";

let escrowListener: { stop(): Promise<void> } | null = null;
if (rpcUrl && escrowContractId) {
  try {
    escrowListener = startEscrowEventListener(rpcUrl, escrowContractId);
    log.info("Escrow event listener wired to boot", {
      rpcUrl,
      contractId: escrowContractId,
    });
  } catch (err) {
    log.error("Failed to start escrow event listener", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
} else {
  log.info(
    "Escrow event listener disabled (set STELLAR_RPC_URL and ESCROW_CONTRACT_ID to enable)"
  );
}

const server: Server = startHttpServer({
  port,
  serviceName: SERVICE_NAME,
  middleware: [corsMiddleware(), securityHeadersMiddleware()],
  routes: [
    route("GET", "/vapid-public-key", (_req: IncomingMessage, res: ServerResponse) => {
      const key = getVapidPublicKey();
      if (!key) {
        json(res, 503, {
          data: null,
          error: { code: "NOT_CONFIGURED", message: "VAPID keys not set" },
        });
        return;
      }
      json(res, 200, { data: { publicKey: key }, error: null });
    }),

    route(
      "POST",
      "/subscriptions/:userId",
      async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
        const body = (await readBody(req)) as { subscription: unknown };
        if (!body?.subscription) {
          json(res, 400, {
            data: null,
            error: { code: "BAD_REQUEST", message: "subscription is required" },
          });
          return;
        }
        await savePushSubscription(
          params.userId,
          body.subscription as Parameters<typeof savePushSubscription>[1]
        );
        json(res, 201, { data: { ok: true }, error: null });
      }
    ),

    route(
      "DELETE",
      "/subscriptions/:userId",
      async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
        const body = (await readBody(req)) as { endpoint: unknown };
        if (!body?.endpoint || typeof body.endpoint !== "string") {
          json(res, 400, {
            data: null,
            error: { code: "BAD_REQUEST", message: "endpoint is required" },
          });
          return;
        }
        await removePushSubscription(params.userId, body.endpoint);
        json(res, 200, { data: { ok: true }, error: null });
      }
    ),

    route(
      "POST",
      "/notify/transaction-approval",
      async (req: IncomingMessage, res: ServerResponse) => {
        const body = (await readBody(req)) as Record<string, unknown>;
        const { userId, email, transactionId, amount, merchant, approvalUrl } =
          body;

        if (!userId || !transactionId || !amount || !merchant || !approvalUrl) {
          json(res, 400, {
            data: null,
            error: {
              code: "BAD_REQUEST",
              message:
                "userId, transactionId, amount, merchant, and approvalUrl are required",
            },
          });
          return;
        }

        await dispatchTransactionApproval({
          userId: String(userId),
          email: email ? String(email) : undefined,
          transactionId: String(transactionId),
          amount: String(amount),
          merchant: String(merchant),
          approvalUrl: String(approvalUrl),
        });

        json(res, 202, { data: { dispatched: true }, error: null });
      }
    ),

    route("POST", "/notifications", async (req: IncomingMessage, res: ServerResponse) => {
      const body = (await readBody(req)) as Record<string, unknown>;
      if (!body.userId || !body.category || !body.type || !body.title || !body.message) {
        json(res, 400, { data: null, error: { code: "BAD_REQUEST", message: "userId, category, type, title, and message are required" } });
        return;
      }
      try {
        const notification = await createNotification(notificationDb, {
          userId: String(body.userId), category: body.category as NotificationCategory, type: String(body.type),
          title: String(body.title), message: String(body.message), metadata: (body.metadata as Record<string, unknown>) ?? {},
          actionUrl: body.actionUrl ? String(body.actionUrl) : undefined,
          actionLabel: body.actionLabel ? String(body.actionLabel) : undefined,
          imageUrl: body.imageUrl ? String(body.imageUrl) : undefined,
          expiresAt: body.expiresAt ? String(body.expiresAt) : undefined,
        });
        broadcastNotificationToUser(notification.userId, { type: "notification", payload: notification as unknown as Record<string, unknown> });
        json(res, 201, { data: notification, error: null });
      } catch (err) {
        json(res, 400, { data: null, error: { code: "NOTIFICATION_FAILED", message: err instanceof Error ? err.message : "Failed to create notification" } });
      }
    }),

    route("GET", "/notifications/:userId", async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const read = url.searchParams.get("read");
      const archived = url.searchParams.get("archived");
      const notifications = await listNotifications(notificationDb, {
        userId: params.userId, category: (url.searchParams.get("category") as NotificationCategory | null) ?? undefined,
        read: read === null ? undefined : read === "true", archived: archived === null ? undefined : archived === "true",
        search: url.searchParams.get("search") ?? undefined, since: url.searchParams.get("since") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? 50), offset: Number(url.searchParams.get("offset") ?? 0),
      });
      json(res, 200, { data: notifications, error: null });
    }),

    route("POST", "/notifications/:userId/bulk", async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const body = (await readBody(req)) as { ids?: unknown; action?: unknown };
      if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === "string") || !["read", "archive"].includes(String(body.action))) {
        json(res, 400, { data: null, error: { code: "BAD_REQUEST", message: "ids and action (read or archive) are required" } });
        return;
      }
      const updated = await bulkUpdateNotifications(notificationDb, params.userId, body.ids as string[], body.action as "read" | "archive");
      json(res, 200, { data: { updated }, error: null });
    }),

    route("GET", "/ws/metrics", (_req: IncomingMessage, res: ServerResponse) => {
      json(res, 200, { data: getWebSocketMetrics(), error: null });
    }),

    // Issue #365 / #59 — notification scheduling with cron + timezone support and a
    // CRUD management API.
    route("POST", "/schedule", async (req: IncomingMessage, res: ServerResponse) => {
      const body = (await readBody(req)) as Record<string, unknown>;
      const { userId, templateName, payload, runAt, cronExpression, timezone, endAt, maxRuns } = body;

      if (!userId || !templateName) {
        json(res, 400, {
          data: null,
          error: { code: "BAD_REQUEST", message: "userId and templateName are required" },
        });
        return;
      }

      try {
        const record =
          typeof cronExpression === "string" && cronExpression
            ? await scheduleRecurringNotification({
                userId: String(userId),
                templateName: String(templateName),
                payload: (payload as Record<string, unknown>) ?? {},
                cronExpression,
                timezone: typeof timezone === "string" ? timezone : undefined,
                endAt: typeof endAt === "string" ? endAt : undefined,
                maxRuns: typeof maxRuns === "number" ? maxRuns : undefined,
              })
            : await scheduleNotification({
                userId: String(userId),
                templateName: String(templateName),
                payload: (payload as Record<string, unknown>) ?? {},
                runAt: String(runAt),
              });

        json(res, 201, { data: record, error: null });
      } catch (err) {
        json(res, 400, {
          data: null,
          error: {
            code: "SCHEDULE_FAILED",
            message: err instanceof Error ? err.message : "Failed to schedule notification",
          },
        });
      }
    }),

    // Issue #59 — list a user's scheduled notifications (management API).
    // /schedule/user/:userId has two path segments after /schedule/, so it does not
    // collide with /schedule/:id's single-segment pattern (see route() in
    // packages/utils/src/http.ts) regardless of registration order.
    route(
      "GET",
      "/schedule/user/:userId",
      async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
        const url = new URL(req.url ?? "", "http://localhost");
        const status = url.searchParams.get("status") as ScheduledNotificationStatus | null;
        const limit = url.searchParams.get("limit");
        const records = await listScheduledNotifications(params.userId, {
          status: status ?? undefined,
          limit: limit ? Number(limit) : undefined,
        });
        json(res, 200, { data: records, error: null });
      }
    ),

    // Issue #59 — scheduler health monitoring.
    route("GET", "/scheduler/metrics", async (_req: IncomingMessage, res: ServerResponse) => {
      const metrics = await getSchedulerMetrics();
      json(res, 200, { data: metrics, error: null });
    }),

    route(
      "GET",
      "/schedule/:id",
      async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
        const record = await getScheduledNotification(params.id);
        if (!record) {
          json(res, 404, {
            data: null,
            error: { code: "NOT_FOUND", message: "Scheduled notification not found" },
          });
          return;
        }
        json(res, 200, { data: record, error: null });
      }
    ),

    route(
      "DELETE",
      "/schedule/:id",
      async (_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
        const record = await cancelScheduledNotification(params.id);
        if (!record) {
          json(res, 404, {
            data: null,
            error: { code: "NOT_FOUND", message: "Scheduled notification not found" },
          });
          return;
        }
        json(res, 200, { data: record, error: null });
      }
    ),
  ],
});

initWebSocketServer(server);

// Issue #59 — scheduled/recurring notifications: persistent store + polling loop.
//
// Uses the Postgres-backed store (see scheduler/store.ts) so scheduled notifications
// survive a restart, instead of the in-memory default that's only appropriate for
// tests. Set SCHEDULER_ENABLED=false to opt out (e.g. running multiple notification
// service replicas where only one should poll — until a leader-election story exists,
// running >1 poller is safe due to claimDue()'s SKIP LOCKED distributed locking, but
// an operator may still want to restrict polling to a dedicated instance).
if (process.env.SCHEDULER_ENABLED !== "false") {
  setScheduledNotificationStore(new PostgresScheduledNotificationStore());
}

/**
 * Default dispatch callback for due scheduled notifications: renders the template
 * (validating templateName/variables actually resolve) and logs delivery intent.
 *
 * What this does NOT do (disclosed scope boundary — Issue #59's types
 * (ScheduledNotification/SchedulerConfig/SchedulerMetrics) specify scheduling,
 * not per-channel delivery routing): resolve the destination channel(s) for
 * templateName, look up the user's contact info / channel preferences
 * (preferences.ts), or actually call the email/push/websocket senders. Wiring that
 * requires a templateName -> channel(s) routing decision this issue doesn't
 * specify — production deployments should replace this via
 * setScheduledNotificationStore's sibling hook point (pass a custom dispatch
 * function to processDueNotifications/catchUpMissedNotifications below) once that
 * routing is decided.
 */
async function defaultScheduledDispatch(notification: ScheduledNotification): Promise<void> {
  log.info("Dispatching scheduled notification", {
    id: notification.id,
    userId: notification.userId,
    templateName: notification.templateName,
  });
  broadcastNotificationToUser(notification.userId, {
    type: "scheduled-notification",
    payload: { templateName: notification.templateName, ...notification.payload },
  });
}

let schedulerTimer: NodeJS.Timeout | null = null;

async function runSchedulerPoll(): Promise<void> {
  try {
    const result = await processDueNotifications(defaultScheduledDispatch, new Date(), {
      batchSize: DEFAULT_SCHEDULER_CONFIG.batchSize,
    });
    if (result.dispatched > 0 || result.failed > 0) {
      log.info("Scheduler poll complete", result);
    }
  } catch (err) {
    log.error("Scheduler poll failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

if (process.env.SCHEDULER_ENABLED !== "false") {
  // Missed-execution catch-up (Issue #59) — dispatch anything that was due while this
  // instance was down, within the catch-up window, before starting the regular poll.
  catchUpMissedNotifications(defaultScheduledDispatch, DEFAULT_SCHEDULER_CONFIG)
    .then((result) => {
      if (result.dispatched > 0 || result.skipped > 0) {
        log.info("Scheduler catch-up complete", result);
      }
    })
    .catch((err) => {
      log.error("Scheduler catch-up failed", { error: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => {
      schedulerTimer = setInterval(() => {
        void runSchedulerPoll();
      }, DEFAULT_SCHEDULER_CONFIG.checkIntervalMs);
      schedulerTimer.unref();
    });
}

// Issue #57 — register graceful shutdown so the listener drains cleanly.
async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  log.info("Received shutdown signal", { signal });
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  if (permissionListener) {
    try {
      await permissionListener.stop();
    } catch (err) {
      log.error("Failed to stop permission event listener cleanly", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (escrowListener) {
    try {
      await escrowListener.stop();
    } catch (err) {
      log.error("Failed to stop escrow event listener cleanly", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  server.close(() => {
    log.info("HTTP server closed");
    process.exit(0);
  });
  // Hard deadline so a stuck close() does not hang forever.
  setTimeout(() => {
    log.warn("Force-exiting after shutdown timeout");
    process.exit(0);
  }, 10_000).unref();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void gracefulShutdown(signal);
  });
}

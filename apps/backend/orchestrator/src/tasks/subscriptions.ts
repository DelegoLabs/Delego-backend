/**
 * @delegolabs/orchestrator — Human task real-time subscriptions
 *
 * Publishes task lifecycle events to Redis channels so the task inbox UI can update
 * in real time without polling. Channel conventions:
 *
 * - `human-task:events` — global stream of all task events (type + task payload).
 * - `human-task:assignee:<id>` — events scoped to a specific assignee's inbox.
 * - `human-task:candidate:<id>` — events for tasks where the user is a candidate.
 *
 * Publishing is best-effort and non-blocking; failures are logged and never fail the
 * underlying task operation. `TaskEventBroker.publish()` is safe to call with no
 * Redis client configured (no-op), which keeps unit tests and degraded deployments
 * working.
 */

import { createLogger } from "@delegolabs/utils";
import type { HumanTask } from "./types.js";

const log = createLogger("orchestrator:tasks:subscriptions", process.env.LOG_LEVEL ?? "info");

export type TaskEventType =
  | "created"
  | "assigned"
  | "claimed"
  | "started"
  | "completed"
  | "rejected"
  | "escalated"
  | "expired"
  | "delegated"
  | "commented"
  | "attached";

export interface TaskEvent {
  type: TaskEventType;
  task: HumanTask;
  actorId?: string;
  timestamp: string;
}

export interface PubSubClient {
  publish(channel: string, message: string): Promise<number> | number;
}

const GLOBAL_CHANNEL = "human-task:events";

export class TaskEventBroker {
  constructor(private readonly client: PubSubClient | null) {}

  async publish(event: Omit<TaskEvent, "timestamp">): Promise<void> {
    if (!this.client) return;
    const envelope: TaskEvent = { ...event, timestamp: new Date().toISOString() };
    const message = JSON.stringify(envelope);
    const channels = [GLOBAL_CHANNEL];
    if (event.task.assignee) channels.push(`human-task:assignee:${event.task.assignee}`);
    for (const candidate of event.task.candidates) {
      channels.push(`human-task:candidate:${candidate}`);
    }
    for (const channel of channels) {
      try {
        await this.client.publish(channel, message);
      } catch (err) {
        log.warn("Failed to publish human task event", {
          channel,
          type: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

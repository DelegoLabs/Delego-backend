/**
 * Issue #530 — Confirmation store for buyer-agent tool approval.
 *
 * Bridges an async agent execution thread with a WebSocket response frame by
 * using Redis pub/sub:
 *
 *   1. `waitForConfirmation(proposalId, timeoutMs)`
 *      Called by the agent execution thread.  Subscribes to a per-proposal
 *      Redis channel and suspends (via Promise) until either a confirmation
 *      frame arrives on that channel OR the timeout fires.
 *
 *   2. `publishConfirmation(proposalId, result)`
 *      Called by the WebSocket handler when the client frame arrives.
 *      Publishes the result JSON to the matching Redis channel.
 *
 * Both sides run in the same process during development / single-instance
 * deployments.  On multi-instance deployments the agent thread and the
 * WebSocket connection may land on different pods — the Redis pub/sub fan-out
 * ensures the right pod wakes up regardless of placement.
 */

import { getRedisPubSubManager, createLogger } from "@delegolabs/utils";
import type { AgentConfirmationResult } from "@delegolabs/types";

const log = createLogger("gateway:confirmation-store", process.env.LOG_LEVEL ?? "info");

/** How long (ms) an agent thread waits for a confirmation before giving up. */
export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 60_000;

/** Redis channel prefix; full channel is `agent:confirm:<proposalId>`. */
const CHANNEL_PREFIX = "agent:confirm:";

/**
 * Publish a confirmation result so that any agent thread waiting on the same
 * `proposalId` can resume.
 */
export async function publishConfirmation(
  proposalId: string,
  result: AgentConfirmationResult
): Promise<void> {
  const pubsub = getRedisPubSubManager();
  const channel = `${CHANNEL_PREFIX}${proposalId}`;

  log.info("Publishing confirmation", { proposalId, confirmed: result.confirmed });

  await pubsub.publish(channel, "confirmation", result);
}

/**
 * Suspend the calling async context until the user either approves or rejects
 * the pending tool call, or until `timeoutMs` elapses.
 *
 * Returns the confirmation result.
 * Throws `ConfirmationTimeoutError` on timeout.
 */
export async function waitForConfirmation(
  proposalId: string,
  timeoutMs: number = DEFAULT_CONFIRMATION_TIMEOUT_MS
): Promise<AgentConfirmationResult> {
  const pubsub = getRedisPubSubManager();
  const channel = `${CHANNEL_PREFIX}${proposalId}`;

  log.info("Waiting for confirmation", { proposalId, timeoutMs });

  return new Promise<AgentConfirmationResult>((resolve, reject) => {
    let subscriptionId: string | null = null;
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;

      log.warn("Confirmation timed out", { proposalId, timeoutMs });

      if (subscriptionId !== null) {
        pubsub.unsubscribe(subscriptionId).catch((err) => {
          log.error("Failed to unsubscribe after timeout", {
            proposalId,
            error: (err as Error).message,
          });
        });
      }

      reject(new ConfirmationTimeoutError(proposalId, timeoutMs));
    }, timeoutMs);

    pubsub
      .subscribe<AgentConfirmationResult>(
        channel,
        async (message) => {
          if (settled) return;
          settled = true;

          clearTimeout(timeoutHandle);

          if (subscriptionId !== null) {
            pubsub.unsubscribe(subscriptionId).catch((err) => {
              log.error("Failed to unsubscribe after confirmation", {
                proposalId,
                error: (err as Error).message,
              });
            });
          }

          log.info("Confirmation received", {
            proposalId,
            confirmed: message.payload.confirmed,
          });

          resolve(message.payload);
        },
        { ackRequired: false }
      )
      .then((id) => {
        subscriptionId = id;
        // If the promise already settled (timeout fired before subscribe
        // returned), clean up the subscription we just created.
        if (settled) {
          pubsub.unsubscribe(id).catch(() => undefined);
        }
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        reject(err);
      });
  });
}

// ─── Error types ────────────────────────────────────────────────────────────

export class ConfirmationTimeoutError extends Error {
  readonly proposalId: string;
  readonly timeoutMs: number;

  constructor(proposalId: string, timeoutMs: number) {
    super(
      `Agent tool confirmation for proposal "${proposalId}" timed out after ${timeoutMs}ms`
    );
    this.name = "ConfirmationTimeoutError";
    this.proposalId = proposalId;
    this.timeoutMs = timeoutMs;
  }
}

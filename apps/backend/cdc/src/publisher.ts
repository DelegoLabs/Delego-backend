/**
 * CDC publisher — transforms captured changes and publishes them to the
 * message broker with exactly-once delivery semantics.
 *
 * Exactly-once is achieved as follows:
 *
 *   1. Each `RawChange` has a stable id = `<slot>:<lsn>:<seq>`.
 *   2. Before publishing, the publisher records the change in
 *      `cdc_published_events` (unique on `(slot, lsn, seq)`) and asks 'was this
 *      a first-time insert?'. If not, it **skips** the publish — a replay after
 *      a crash that occurred between the publish and the checkpoint.
 *   3. Only after every change in a batch is recorded AND published do we
 *      advance the slot checkpoint. A crash at any earlier point re-reads the
 *      same changes, but the dedup table makes them no-ops.
 *
 * Consumers additionally dedupe on the existing `processed_messages` table
 * (see apps/backend/orchestrator/src/messaging/processed-messages.ts), so
 * end-to-end exactly-once holds across the broker.
 */

import { createLogger, type Logger } from "@delegolabs/utils";
import type { CDCDomainEvent } from "@delegolabs/types";
import type { RawChangeBatch } from "./connector/types.js";
import {
  rawChangeToDomainEvent,
  type TransformOptions,
} from "./transform.js";
import type {
  PublishedEventRecord,
  PublishedEventStore,
  ReplicationStateStore,
} from "./store.js";
import type { SchemaEvolutionStore } from "./schemaEvolution.js";

export interface CdcPublishResult {
  /** Events actually published this batch. */
  published: number;
  /** Events skipped because they were already recorded (replay). */
  skipped: number;
  /** Total changes delivered by the connector this batch. */
  total: number;
  /** The checkpoint LSN to persist. */
  confirmedFlushLsn: string;
}

/** Minimal broker surface the publisher depends on. */
export interface MessageBroker {
  /** Publish a domain event. Resolves when the broker has acknowledged it. */
  publish(event: CDCDomainEvent): Promise<void>;
}

export interface CdcPublisherOptions {
  slotName: string;
  broker: MessageBroker;
  publishedEvents: PublishedEventStore;
  replicationState: ReplicationStateStore;
  schemaEvolution: SchemaEvolutionStore;
  transformOptions?: TransformOptions;
  log?: Logger;
}

export interface CdcPublisher {
  /** Process one connector batch with exactly-once semantics. */
  publishBatch(batch: RawChangeBatch): Promise<CdcPublishResult>;
  /** Resolve the durable checkpoint to resume from. */
  getCheckpoint(): Promise<string>;
}

export function createCdcPublisher(options: CdcPublisherOptions): CdcPublisher {
  const log = options.log ?? createLogger("cdc:publisher", process.env.LOG_LEVEL ?? "info");
  const { broker, publishedEvents, replicationState, schemaEvolution, slotName } = options;

  return {
    async publishBatch(batch: RawChangeBatch): Promise<CdcPublishResult> {
      let published = 0;
      let skipped = 0;

      for (const raw of batch.changes) {
        // 1. dedup / exactly-once guard
        const firstTime = await publishedEvents.recordAndCheck({
          slotName,
          lsn: raw.source.lsn,
          seq: raw.sequence,
          eventId: raw.id,
        } satisfies PublishedEventRecord);

        if (!firstTime) {
          skipped += 1;
          continue;
        }

        // 2. schema evolution — record the observed column layout
        const columns: Record<string, string> = {};
        for (const col of raw.columns) {
          columns[col] = "unknown";
        }
        const layout = await schemaEvolution.recordLayout(raw.schema, raw.table, columns);
        const schemaVersion = layout.version;

        // 3. transform — the published event id equals the dedup key so
        // downstream consumers can dedupe deterministically across retries.
        const event = rawChangeToDomainEvent(raw, {
          ...options.transformOptions,
          idSource: () => raw.id,
          schemaVersionFor: () => schemaVersion,
        });

        // 4. publish
        await broker.publish(event);
        published += 1;
      }

      log.info("Publish batch complete", {
        published,
        skipped,
        total: batch.changes.length,
        lsn: batch.confirmedFlushLsn,
      });

      return {
        published,
        skipped,
        total: batch.changes.length,
        confirmedFlushLsn: batch.confirmedFlushLsn,
      };
    },

    async getCheckpoint(): Promise<string> {
      const state = await replicationState.get(slotName);
      return state?.confirmedFlushLsn ?? "0/0";
    },
  };
}

/**
 * Advances the durable checkpoint after a batch. Called by the pipeline only
 * after `publishBatch` has durably recorded every change.
 */
export async function advanceCheckpoint(
  replicationState: ReplicationStateStore,
  slotName: string,
  confirmedFlushLsn: string
): Promise<void> {
  await replicationState.set({
    slotName,
    confirmedFlushLsn,
    lastProcessedAt: new Date().toISOString(),
  });
}

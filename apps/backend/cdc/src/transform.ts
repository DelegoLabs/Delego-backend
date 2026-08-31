/**
 * Event transformation — normalises a connector `RawChange` into a canonical
 * `CDCEvent`/`CDCDomainEvent`, applying the schema version the source table
 * was at when the change was observed.
 */

import { randomUUID } from "node:crypto";
import type { CDCDomainEvent, CDCEvent, CDCEventType } from "@delegolabs/types";
import type { RawChange } from "./connector/types.js";

/** The topic a CDC domain event is published to for a given table. */
export function tableTopic(
  topicPrefix: string,
  schema: string,
  table: string
): string {
  return `${topicPrefix}:${schema}:${table}`;
}

/**
 * The domain event type for an op, e.g. `orders.row.inserted`.
 */
export function domainEventType(
  table: string,
  kind: CDCEventType
): string {
  const verb =
    kind === "INSERT" ? "inserted" : kind === "UPDATE" ? "updated" : "deleted";
  return `${table}.row.${verb}`;
}

export interface TransformOptions {
  topicPrefix?: string;
  /** Inject a stable id source (for tests). */
  idSource?: () => string;
  /** Resolve a schema version for a table; falls back to 1. */
  schemaVersionFor?: (schema: string, table: string) => number;
}

/**
 * Build a canonical `CDCEvent` from a `RawChange`.
 */
export function rawChangeToCdcEvent(
  raw: RawChange,
  options: { idSource?: () => string } = {}
): CDCEvent {
  const id = options.idSource ? options.idSource() : randomUUID();
  return {
    eventId: id,
    eventType: raw.kind as CDCEventType,
    table: raw.table,
    schema: raw.schema,
    timestamp: raw.source.timestamp,
    before: raw.before,
    after: raw.after,
    source: raw.source,
  };
}

/**
 * Build the message-broker `CDCDomainEvent` for a change, including routing
 * metadata and the schema version the payload was projected with.
 */
export function rawChangeToDomainEvent(
  raw: RawChange,
  options: TransformOptions = {}
): CDCDomainEvent {
  const {
    topicPrefix = "cdc",
    idSource = randomUUID,
    schemaVersionFor = () => 1,
  } = options;

  const event = rawChangeToCdcEvent(raw, { idSource });
  const schemaVersion = schemaVersionFor(raw.schema, raw.table);

  return {
    id: event.eventId,
    topic: tableTopic(topicPrefix, raw.schema, raw.table),
    domainEventType: domainEventType(raw.table, raw.kind),
    sourceTable: raw.table,
    sourceSchema: raw.schema,
    op: raw.kind as CDCEventType,
    payload: (raw.after ?? raw.before ?? {}) as Record<string, unknown>,
    occurredAt: raw.source.timestamp,
    source: raw.source,
    schemaVersion,
    correlationId: raw.id,
  };
}

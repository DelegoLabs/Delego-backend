/**
 * CDC connector abstraction.
 *
 * A connector captures raw row changes from a source database and normalises
 * them into connector-agnostic `RawChange` records. The rest of the pipeline
 * (transformation, publication, schema-evolution, metrics) only depends on
 * this normalised shape, which is what lets the same pipeline run on either
 * a self-managed PostgreSQL logical replication slot or an external Debezium
 * cluster.
 */

import type { CDCEventType } from "@delegolabs/types";

/** Normalised, connector-agnostic view of one captured row change. */
export interface RawChange {
  /** Stable id: `${slotName}:${lsn}:${seq}` — used for exactly-once dedup. */
  id: string;
  kind: CDCEventType;
  schema: string;
  table: string;
  /** Snapshot of the row before the change (UPDATE/DELETE). */
  before?: Record<string, unknown>;
  /** Snapshot of the row after the change (INSERT/UPDATE). */
  after?: Record<string, unknown>;
  /** The columns present in `after`/`before`, used for schema-versioning. */
  columns: string[];
  source: {
    lsn: string;
    txId: number;
    timestamp: string;
  };
  /** Connector-specific ordering within a single LSN (usually 1). */
  sequence: number;
  /** Set of columns newly observed this batch (schema evolution signals). */
  newColumns?: string[];
  /** Set of columns that disappeared this batch (schema evolution signals). */
  droppedColumns?: string[];
}

/** One batch of raw changes delivered by a connector. */
export interface RawChangeBatch {
  changes: RawChange[];
  /** Confirmed flush LSN (checkpoint) the connector is at after this batch. */
  confirmedFlushLsn: string;
}

/** Snapshot of connector health / position used by the monitoring dashboard. */
export interface ConnectorPosition {
  startingLsn: string;
  latestLsn: string;
  /** ms since the source database reported its latest change. */
  lagMs: number;
  lastEventAt: string;
}

export interface CDCConnector {
  /** The kind of connector this is. */
  readonly kind: "debezium" | "logical_replication";
  /** Connector slot/publication this instance owns. */
  readonly slotName: string;

  /**
   * Bring the source up to a state where it can deliver changes (e.g. create
   * the publication and replication slot). Returns the LSN the connector
   * should resume from.
   */
  initialize(resumeLsn?: string): Promise<string>;

  /**
   * Pull the next batch of changes. Returns `null` when there is nothing new
   * yet (the caller controls the poll cadence).
   */
  readBatch(): Promise<RawChangeBatch | null>;

  /** Acknowledge/checkpoint that a batch at `confirmedFlushLsn` is durable. */
  commit(confirmedFlushLsn: string): Promise<void>;

  /** Report the connector's current position for metrics. */
  position(): ConnectorPosition;

  /** Tear down long-lived resources. */
  close(): Promise<void>;
}

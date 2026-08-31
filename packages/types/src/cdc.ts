/**
 * @delegolabs/types — Change Data Capture (CDC)
 *
 * Shared types for the CDC pipeline: configuration, the canonical CDCEvent
 * shape, and the metrics reported by the monitoring dashboard.
 *
 * The CDC service (`apps/backend/cdc`) captures row changes from a PostgreSQL
 * database via logical replication (or an external Debezium connect cluster),
 * transforms them into domain events, and publishes those events to the Redis
 * message bus with exactly-once semantics.
 */

/** Which connector strategy backs the CDC pipeline. */
export type CDCConnectorKind = "debezium" | "logical_replication";

/** Static configuration for a single source database and its WAL source. */
export interface CDCConfig {
  connector: CDCConnectorKind;
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  };
  tables: Array<{
    schema: string;
    table: string;
    pkColumns: string[];
  }>;
  publication: string;
  slotName: string;
}

/** The row operation kind captured by CDC. */
export type CDCEventType = "INSERT" | "UPDATE" | "DELETE";

/**
 * A single captured change, already normalised from the connector's native
 * representation into a connector-agnostic audit event.
 */
export interface CDCEvent {
  eventId: string;
  eventType: CDCEventType;
  table: string;
  schema: string;
  timestamp: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  source: {
    lsn: string;
    txId: number;
    timestamp: string;
  };
}

/**
 * A `CDCEvent` published to the message bus, wrapped with routing metadata so
 * consumers can subscribe to a single CDC topic and filter by domain.
 */
export interface CDCDomainEvent<T = Record<string, unknown>> {
  id: string;
  topic: string;
  domainEventType: string;
  sourceTable: string;
  sourceSchema: string;
  op: CDCEventType;
  payload: T;
  occurredAt: string;
  source: {
    lsn: string;
    txId: number;
    timestamp: string;
  };
  /** Schema version of the source table this event was projected against. */
  schemaVersion: number;
  correlationId?: string;
}

/** Runtime health + throughput view surfaced by the monitoring dashboard. */
export interface CDCMetrics {
  connector: CDCConnectorKind;
  status: "running" | "stopped" | "error";
  eventsProcessed: number;
  eventsPerSecond: number;
  lagMs: number;
  lastEventAt: string;
  errors: Array<{
    timestamp: string;
    error: string;
  }>;
}

/** Schema-evolution descriptor recorded when a source table's shape changes. */
export interface CDCSchemaChange {
  schema: string;
  table: string;
  /** Incremented each time the captured column set changes. */
  version: number;
  /** Column -> type mapping as observed at this version. */
  columns: Record<string, string>;
  /** ISO timestamp of when the change was observed. */
  detectedAt: string;
}

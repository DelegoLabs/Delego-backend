/**
 * Debezium connector.
 *
 * Integrates with an external Debezium (Kafka Connect) cluster configured to
 * stream the same `CDCConfig.tables` via a logical replication slot. Debezium
 * emits change events in its standard envelope:
 *
 *   {
 *     before: {...} | null,
 *     after:  {...} | null,
 *     source: { table, schema, lsn, txId, ts_ms, ... },
 *     op: "c" | "u" | "d" | "r"
 *   }
 *
 * This connector consumes those envelopes from a pluggable source and
 * normalises them into `RawChange` records so the rest of the pipeline is
 * identical regardless of which connector backs it.
 *
 * Because this repo has no Kafka broker, production deployments configure a
 * `DebeziumSource` that reads from the Debezium change-event output (e.g. an
 * HTTP sink or a shared stream). Unit tests drive the connector directly with
 * a fake source.
 */

import type { CDCConfig } from "@delegolabs/types";
import { createLogger, type Logger } from "@delegolabs/utils";
import {
  type CDCConnector,
  type ConnectorPosition,
  type RawChange,
  type RawChangeBatch,
} from "./types.js";

/** A single Debezium change envelope (subset of the full payload). */
export interface DebeziumEnvelope {
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  source?: {
    table?: string;
    schema?: string;
    lsn?: number | string;
    txId?: number | string;
    ts_ms?: number;
  };
  op?: "c" | "u" | "d" | "r" | string;
}

/** Source of Debezium envelopes. */
export interface DebeziumSource {
  /** Pull up to `limit` envelopes. Returns [] when none are available. */
  read(limit: number): Promise<DebeziumEnvelope[]>;
}

/** Maps a Debezium `op` code onto our canonical op kind. */
export function mapDebeziumOp(op: string | undefined): "INSERT" | "UPDATE" | "DELETE" | null {
  switch (op) {
    case "c":
    case "r":
      return "INSERT";
    case "u":
      return "UPDATE";
    case "d":
      return "DELETE";
    default:
      return null;
  }
}

/**
 * Normalise one Debezium envelope into a `RawChange`. Returns null for
 * snapshots ("r") already applied, malformed rows, or ops we don't track.
 */
export function envelopeToRawChange(
  envelope: DebeziumEnvelope,
  slotName: string,
  sequence: number
): RawChange | null {
  const kind = mapDebeziumOp(envelope.op);
  if (!kind) return null;

  const schema = envelope.source?.schema ?? "public";
  const table = envelope.source?.table ?? "";

  const before = envelope.before ?? undefined;
  const after = envelope.after ?? undefined;

  const afterNonNull = after && Object.keys(after).length > 0 ? after : undefined;
  const beforeNonNull = before && Object.keys(before).length > 0 ? before : undefined;

  if (!afterNonNull && !beforeNonNull) return null;

  const columns = [
    ...new Set([
      ...(beforeNonNull ? Object.keys(beforeNonNull) : []),
      ...(afterNonNull ? Object.keys(afterNonNull) : []),
    ]),
  ];

  const lsn = String(envelope.source?.lsn ?? "0/0");
  const txId = Number(envelope.source?.txId ?? 0);
  const ts = envelope.source?.ts_ms
    ? new Date(envelope.source.ts_ms).toISOString()
    : new Date().toISOString();

  return {
    id: `${slotName}:${lsn}:${sequence}`,
    kind,
    schema,
    table,
    before: beforeNonNull,
    after: afterNonNull,
    columns,
    source: { lsn, txId, timestamp: ts },
    sequence,
  };
}

export interface DebeziumConnectorOptions {
  config: CDCConfig;
  source: DebeziumSource;
  log?: Logger;
  batchLimit?: number;
}

export class DebeziumConnector implements CDCConnector {
  readonly kind = "debezium" as const;
  readonly slotName: string;

  private readonly config: CDCConfig;
  private readonly source: DebeziumSource;
  private readonly log: Logger;
  private readonly batchLimit: number;

  private startingLsn = "0/0";
  private latestLsn = "0/0";
  private lastEventAt = "";

  constructor(options: DebeziumConnectorOptions) {
    this.config = options.config;
    this.source = options.source;
    this.log = options.log ?? createLogger("cdc:debezium", process.env.LOG_LEVEL ?? "info");
    this.batchLimit = options.batchLimit ?? 200;
    this.slotName = options.config.slotName;
  }

  async initialize(resumeLsn?: string): Promise<string> {
    // Debezium owns the slot; we just track where we should resume from.
    this.startingLsn = resumeLsn ?? "0/0";
    this.latestLsn = this.startingLsn;
    this.log.info("Debezium connector initialized", {
      publication: this.config.publication,
      resumeLsn: this.startingLsn,
    });
    return this.startingLsn;
  }

  async readBatch(): Promise<RawChangeBatch | null> {
    const envelopes = await this.source.read(this.batchLimit);
    if (!envelopes || envelopes.length === 0) {
      return null;
    }

    const changes: RawChange[] = [];
    for (let i = 0; i < envelopes.length; i++) {
      const parsed = envelopeToRawChange(envelopes[i], this.slotName, i + 1);
      if (parsed) {
        changes.push(parsed);
        this.latestLsn = parsed.source.lsn;
        this.lastEventAt = parsed.source.timestamp;
      }
    }

    if (changes.length === 0) return null;

    return { changes, confirmedFlushLsn: this.latestLsn };
  }

  async commit(_confirmedFlushLsn: string): Promise<void> {
    // Debezium/Kafka handles offset commit; the pipeline's persisted
    // checkpoint drives cooperative resume on this side.
  }

  position(): ConnectorPosition {
    return {
      startingLsn: this.startingLsn,
      latestLsn: this.latestLsn,
      lagMs: this.lastEventAt ? Math.max(0, Date.now() - Date.parse(this.lastEventAt)) : 0,
      lastEventAt: this.lastEventAt,
    };
  }

  async close(): Promise<void> {
    this.log.info("Debezium connector closed");
  }
}

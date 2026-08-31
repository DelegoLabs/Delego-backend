/**
 * PostgreSQL logical replication connector.
 *
 * Implements a CDC connector backed by a native PostgreSQL logical
 * replication slot. It:
 *
 *   - ensures the target publication exists (CREATE PUBLICATION ... FOR ALL
 *     TABLE filtered to the configured tables),
 *   - ensures the logical replication slot exists
 *     (pg_create_logical_replication_slot with the `test_decoding` plugin,
 *     which ships with PostgreSQL and needs no extra install),
 *   - polls `pg_logical_slot_get_changes(...)` for decoded WAL changes and
 *     normalises them into `RawChange` records.
 *
 * Decoding format: the `test_decoding` plugin emits rows as
 * `(lsn, xid, data)` where `data` is a human-readable representation of each
 * change, e.g. `table public.orders: INSERT: id[integer]:1 amount[integer]:2`.
 * We parse this line format, which gives us before/after column snapshots
 * without requiring the `wal2json` extension. Column type names are recorded
 * so schema-evolution can detect type/column drift.
 */

import type { CDCEventType } from "@delegolabs/types";
import type { Pool, PoolClient } from "pg";

import { createLogger, type Logger } from "@delegolabs/utils";
import type { CDCConfig } from "@delegolabs/types";
import {
  type CDCConnector,
  type ConnectorPosition,
  type RawChange,
  type RawChangeBatch,
} from "./types.js";

const DECODING_PLUGIN = "test_decoding";
const POLL_BATCH_LIMIT = 200;

export interface LogicalReplicationOptions {
  config: CDCConfig;
  /** `pg.Pool`/`Client` used for metadata + slot management. */
  pool: Pool;
  /** Optional injected SQL runner (for tests). */
  run?: (sql: string) => Promise<void>;
  log?: Logger;
  /** Number of WAL change rows to request per poll (default 200). */
  batchLimit?: number;
}

interface SlotRow {
  lsn: string;
  xid: number;
  data: string;
}

function parseColumnType(fragment: string): { column: string; type: string } | null {
  // fragment like `amount[integer]` or `id[integer]`
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\[([A-Za-z0-9_]+)\]$/.exec(fragment.trim());
  if (!m) return null;
  return { column: m[1], type: m[2] };
}

/**
 * Parse one `test_decoding` data line into a `RawChange`.
 *
 * Supported lines:
 *   table public.orders: INSERT: id[integer]:1 amount[integer]:2
 *   table public.orders: UPDATE: id[integer]:1 amount[integer]:2
 *   table public.orders: DELETE: id[integer]:1
 *   table public.orders: UPDATE: old-key: id[integer]:1 new-tuple: id[integer]:1
 */
export function parseDecodeLine(
  data: string,
  lsn: string,
  txId: number,
  txTimestamp: string,
  slotName: string,
  sequence: number
): RawChange | null {
  // Strip leading "table <schema>.<table>: "
  const tableMatch = /^table\s+([A-Za-z_][A-Za-z0-9_.$]*):\s*(.*)$/i.exec(data.trim());
  if (!tableMatch) return null;
  const tableRef = tableMatch[1];
  const rest = tableMatch[2];

  const dot = tableRef.lastIndexOf(".");
  const schema = dot >= 0 ? tableRef.slice(0, dot) : "public";
  const table = dot >= 0 ? tableRef.slice(dot + 1) : tableRef;

  const opMatch = /^(INSERT|UPDATE|DELETE):\s*(.*)$/.exec(rest);
  if (!opMatch) return null;
  const kind = opMatch[1] as CDCEventType;
  const body = opMatch[2];

  let before: Record<string, unknown> | undefined;
  let after: Record<string, unknown> | undefined;
  let columns: string[] = [];

  if (kind === "DELETE") {
    before = parseTupleFragment(body);
  } else if (kind === "INSERT") {
    after = parseTupleFragment(body);
  } else {
    // UPDATE may carry `old-key: ... new-tuple: ...`
    const oldKeyMatch = /old-key:\s*(.*?)(?:\s+new-tuple:|\s*$)/.exec(body);
    const newTupleMatch = /new-tuple:\s*(.*)$/.exec(body);
    if (newTupleMatch) {
      after = parseTupleFragment(newTupleMatch[1]);
      before = oldKeyMatch ? parseTupleFragment(oldKeyMatch[1]) : undefined;
    } else {
      after = parseTupleFragment(body);
    }
  }

  columns = [...new Set([...(before ? Object.keys(before) : []), ...(after ? Object.keys(after) : [])])];

  if (!before && !after) {
    return null;
  }

  return {
    id: `${slotName}:${lsn}:${sequence}`,
    kind,
    schema,
    table,
    before,
    after,
    columns,
    source: { lsn, txId, timestamp: txTimestamp },
    sequence,
  };
}

/** Parse the `col[type]:value col[type]:value ...` tuple into an object. */
export function parseTupleFragment(fragment: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // tokenise on spaces, but values themselves shouldn't contain spaces for
  // our supported column types in this decoder.
  const tokens = fragment.trim().split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const sep = token.indexOf(":");
    if (sep < 0) continue;
    const colPart = token.slice(0, sep);
    const valuePart = token.slice(sep + 1);
    const parsed = parseColumnType(colPart);
    if (!parsed) continue;
    result[parsed.column] = coerceValue(valuePart, parsed.type);
  }
  return result;
}

function coerceValue(raw: string, type: string): unknown {
  if (raw === "NULL" || raw === "null") return null;
  if (/int|numeric|float|double|bigint|serial/i.test(type) && raw !== "") {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (/bool/i.test(type)) {
    if (raw === "t" || raw === "true") return true;
    if (raw === "f" || raw === "false") return false;
  }
  return raw;
}

/**
 * A test/development-friendly connector that reads `pg_logical_slot_get_changes`.
 * `run` is injectable so unit tests can simulate the slot/publication management
 * and `readBatch` can be driven against a fake row source.
 */
export class LogicalReplicationConnector implements CDCConnector {
  readonly kind = "logical_replication" as const;
  readonly slotName: string;

  private readonly config: CDCConfig;
  private readonly pool: Pool;
  private run: (sql: string) => Promise<void>;
  private readonly log: Logger;
  private readonly batchLimit: number;

  private startingLsn = "0/0";
  private latestLsn = "0/0";
  private lastEventAt = "";
  private client?: PoolClient;

  private pollSql?: (
    lsn: string,
    limit: number
  ) => Promise<SlotRow[]>;

  constructor(options: LogicalReplicationOptions) {
    this.config = options.config;
    this.pool = options.pool;
    this.run = options.run ?? (async (sql) => {
      await this.pool.query(sql);
    });
    this.log = options.log ?? createLogger("cdc:logical-replication", process.env.LOG_LEVEL ?? "info");
    this.batchLimit = options.batchLimit ?? POLL_BATCH_LIMIT;
    this.slotName = options.config.slotName;
  }

  /**
   * Test hook: replace the slot changes source. `fn` receives the resume LSN
   * and batch limit and returns decoded slot rows.
   */
  _setPollSource(fn: (lsn: string, limit: number) => Promise<SlotRow[]>): void {
    this.pollSql = fn;
  }

  /**
   * Test hook: replace the run helper so publication/slot management is a
   * no-op against a fake database.
   */
  _setRun(run: (sql: string) => Promise<void>): void {
    this.run = run;
  }

  private tableFilter(): string {
    return this.config.tables
      .map((t) => `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`)
      .join(", ");
  }

  async initialize(resumeLsn?: string): Promise<string> {
    // idempotent publication + slot creation
    await this.run(`CREATE PUBLICATION IF NOT EXISTS ${quoteIdent(this.config.publication)} FOR TABLE ${this.tableFilter()}`);
    await this.run(
      `SELECT pg_create_logical_replication_slot(${quoteLiteral(this.config.slotName)}, ${quoteLiteral(DECODING_PLUGIN)}, false) WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = ${quoteLiteral(this.config.slotName)})`
    );

    this.startingLsn = resumeLsn ?? "0/0";
    this.latestLsn = this.startingLsn;
    this.log.info("Logical replication connector initialized", {
      slot: this.config.slotName,
      publication: this.config.publication,
      resumeLsn: this.startingLsn,
    });
    return this.startingLsn;
  }

  async ensureInitialized(): Promise<void> {
    // Re-run publication + slot creation cheaply; both are idempotent.
    await this.run(`CREATE PUBLICATION IF NOT EXISTS ${quoteIdent(this.config.publication)} FOR TABLE ${this.tableFilter()}`);
  }

  async readBatch(): Promise<RawChangeBatch | null> {
    await this.ensureInitialized();

    if (!this.pollSql) {
      this.pollSql = async (lsn: string, limit: number) => {
        const client = await this.getClient();
        const res = await client.query<SlotRow>(
          `SELECT lsn, xid, data FROM pg_logical_slot_get_changes(${quoteLiteral(this.config.slotName)}, ${quoteLiteral(lsn)}, ${limit}, 'include-timestamp', '1')`
        );
        return res.rows;
      };
    }

    const rows = await this.pollSql(this.latestLsn, this.batchLimit);
    if (!rows || rows.length === 0) {
      return null;
    }

    const changes: RawChange[] = [];
    let batchLsn = this.latestLsn;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      batchLsn = row.lsn;
      const parsed = parseDecodeLine(
        row.data,
        row.lsn,
        row.xid,
        new Date().toISOString(),
        this.slotName,
        i + 1
      );
      if (parsed) {
        changes.push(parsed);
        this.lastEventAt = parsed.source.timestamp;
      }
    }

    this.latestLsn = batchLsn;
    if (changes.length > 0) {
      this.log.debug("Read batch from logical replication", { count: changes.length, lsn: batchLsn });
    }
    return { changes, confirmedFlushLsn: batchLsn };
  }

  async commit(confirmedFlushLsn: string): Promise<void> {
    // With `pg_logical_slot_get_changes` consumption, we advance the confirmed
    // flush LSN so the slot can be trimmed. We persist the checkpoint via the
    // higher-level state store (not here) to keep the connector transport-only.
    this.log.debug("Logical replication commit", { lsn: confirmedFlushLsn });
  }

  position(): ConnectorPosition {
    return {
      startingLsn: this.startingLsn,
      latestLsn: this.latestLsn,
      lagMs: this.lastEventAt ? Math.max(0, Date.now() - Date.parse(this.lastEventAt)) : 0,
      lastEventAt: this.lastEventAt,
    };
  }

  private async getClient(): Promise<PoolClient> {
    if (!this.client) {
      this.client = await this.pool.connect();
    }
    return this.client;
  }

  async close(): Promise<void> {
    if (this.client) {
      this.client.release();
      this.client = undefined;
    }
  }
}

export function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

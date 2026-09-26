/**
 * Real-Time Soroban Contract Event Ingestion Worker
 *
 * Continuous background poller that streams contract events
 * (deposit, release, dispute, refund) from Soroban RPC,
 * stores a cursor in Redis for at-least-once delivery,
 * and publishes normalized events to a Redis Stream.
 *
 * Closes #285
 */

import { Redis } from "ioredis";
import { createLogger, type Logger } from "@delegolabs/utils";

const log = createLogger("cdc:sorobanEvents", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Types (matching issue spec)
// ---------------------------------------------------------------------------

export interface ContractEventCursor {
  contractId: string;
  lastLedgerSequence: number;
  cursorToken?: string;
}

export interface NormalizedContractEvent {
  contractId: string;
  topic: string;
  data: Record<string, unknown>;
  ledger: number;
  txHash: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURSOR_KEY_PREFIX = "soroban:cursor:";
const STREAM_KEY = "soroban:events";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BACKOFF_MS = 2_000;

// ---------------------------------------------------------------------------
// Soroban RPC Client
// ---------------------------------------------------------------------------

export interface SorobanRpcConfig {
  rpcUrl: string;
  contractIds: string[];
  pollIntervalMs?: number;
  pageSize?: number;
}

export class SorobanRpcClient {
  private rpcUrl: string;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  /**
   * Call Soroban RPC getEvents with paging.
   */
  async getEvents(params: {
    startLedger?: number;
    cursor?: string;
    limit?: number;
    filters?: Array<{ type?: string; contractIds?: string[]; topics?: string[][] }>;
  }): Promise<{
    events: RawSorobanEvent[];
    cursor: string;
    latestLedger: number;
  }> {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "getEvents",
      params: {
        startLedger: params.startLedger,
        cursor: params.cursor,
        limit: params.limit ?? DEFAULT_PAGE_SIZE,
        filters: params.filters ?? [],
      },
    };

    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Soroban RPC error: ${response.status} ${await response.text()}`);
    }

    const result = await response.json() as any;

    if (result.error) {
      throw new Error(`Soroban RPC error: ${result.error.message ?? JSON.stringify(result.error)}`);
    }

    return {
      events: (result.result?.events ?? []) as RawSorobanEvent[],
      cursor: result.result?.cursor ?? params.cursor ?? "",
      latestLedger: result.result?.latestLedger ?? 0,
    };
  }
}

export interface RawSorobanEvent {
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  id: string;
  pagingToken: string;
  topic: string[];
  value: { xdr?: string; str?: string };
  inSuccessfulContractCall: boolean;
  txHash: string;
}

// ---------------------------------------------------------------------------
// Cursor Store
// ---------------------------------------------------------------------------

export class CursorStore {
  private redis: Redis;
  private log: Logger;

  constructor(redis: Redis, logger?: Logger) {
    this.redis = redis;
    this.log = logger ?? createLogger("cdc:cursorStore", process.env.LOG_LEVEL ?? "info");
  }

  /**
   * Save the event cursor for a contract — guarantees at-least-once ingestion.
   */
  async saveCursor(cursor: ContractEventCursor): Promise<void> {
    const key = `${CURSOR_KEY_PREFIX}${cursor.contractId}`;
    await this.redis.hset(key, {
      lastLedgerSequence: String(cursor.lastLedgerSequence),
      cursorToken: cursor.cursorToken ?? "",
      updatedAt: new Date().toISOString(),
    });
    this.log.debug("Cursor saved", cursor);
  }

  /**
   * Load the saved cursor for a contract to resume from.
   */
  async loadCursor(contractId: string): Promise<ContractEventCursor | null> {
    const key = `${CURSOR_KEY_PREFIX}${contractId}`;
    const data = await this.redis.hgetall(key);

    if (!data || !data.lastLedgerSequence) {
      return null;
    }

    return {
      contractId,
      lastLedgerSequence: Number(data.lastLedgerSequence),
      cursorToken: data.cursorToken || undefined,
    };
  }

  /**
   * Clear cursor for a contract (used in tests or manual reset).
   */
  async clearCursor(contractId: string): Promise<void> {
    await this.redis.del(`${CURSOR_KEY_PREFIX}${contractId}`);
  }
}

// ---------------------------------------------------------------------------
// Event Normalizer
// ---------------------------------------------------------------------------

export function normalizeEvent(raw: RawSorobanEvent): NormalizedContractEvent {
  const topic = raw.topic.length > 0
    ? raw.topic[0].replace(/"/g, "")
    : "unknown";

  let data: Record<string, unknown> = {};
  if (raw.value?.xdr) {
    data = { xdr: raw.value.xdr };
  } else if (raw.value?.str) {
    try {
      data = JSON.parse(raw.value.str);
    } catch {
      data = { raw: raw.value.str };
    }
  }

  return {
    contractId: raw.contractId,
    topic,
    data,
    ledger: raw.ledger,
    txHash: raw.txHash,
    timestamp: raw.ledgerClosedAt,
  };
}

// ---------------------------------------------------------------------------
// Ingestion Worker
// ---------------------------------------------------------------------------

export class SorobanEventIngestionWorker {
  private rpcClient: SorobanRpcClient;
  private cursorStore: CursorStore;
  private redis: Redis;
  private config: SorobanRpcConfig;
  private log: Logger;
  private running: boolean = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  constructor(
    redis: Redis,
    config: SorobanRpcConfig,
    options?: {
      rpcClient?: SorobanRpcClient;
      cursorStore?: CursorStore;
      logger?: Logger;
    },
  ) {
    this.redis = redis;
    this.config = config;
    this.rpcClient = options?.rpcClient ?? new SorobanRpcClient(config.rpcUrl);
    this.cursorStore = options?.cursorStore ?? new CursorStore(redis);
    this.log = options?.logger ?? createLogger("cdc:sorobanEvents", process.env.LOG_LEVEL ?? "info");
  }

  /**
   * Start the background ingestion worker.
   */
  start(): void {
    if (this.running) {
      this.log.warn("Ingestion worker already running");
      return;
    }
    this.running = true;
    this.log.info("Soroban event ingestion started", {
      rpcUrl: this.config.rpcUrl,
      contracts: this.config.contractIds,
      pollIntervalMs: this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    });
    this.poll();
  }

  /**
   * Stop the background ingestion worker.
   */
  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.log.info("Soroban event ingestion stopped");
  }

  /**
   * Main poll loop — fetches events, normalizes, publishes, saves cursor.
   */
  private poll(): void {
    if (!this.running) return;

    this.ingestAll()
      .then(() => {
        this.reconnectAttempts = 0;
      })
      .catch((err) => {
        this.reconnectAttempts++;
        this.log.error("Ingestion poll failed", {
          error: err instanceof Error ? err.message : String(err),
          reconnectAttempts: this.reconnectAttempts,
        });

        if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          this.log.error("Max reconnect attempts reached, stopping worker");
          this.running = false;
          return;
        }
      })
      .finally(() => {
        if (this.running) {
          const delay = this.reconnectAttempts > 0
            ? RECONNECT_BACKOFF_MS * this.reconnectAttempts
            : this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
          this.pollTimer = setTimeout(() => this.poll(), delay);
        }
      });
  }

  /**
   * Ingest events for all configured contracts.
   */
  async ingestAll(): Promise<number> {
    let totalIngested = 0;
    for (const contractId of this.config.contractIds) {
      const count = await this.ingestContract(contractId);
      totalIngested += count;
    }
    if (totalIngested > 0) {
      this.log.info("Ingestion batch complete", { totalIngested });
    }
    return totalIngested;
  }

  /**
   * Ingest events for a single contract — fetch, normalize, publish, save cursor.
   */
  async ingestContract(contractId: string): Promise<number> {
    // Load saved cursor for at-least-once delivery
    const cursor = await this.cursorStore.loadCursor(contractId);

    // Fetch events from Soroban RPC
    const response = await this.rpcClient.getEvents({
      startLedger: cursor?.lastLedgerSequence,
      cursor: cursor?.cursorToken,
      limit: this.config.pageSize ?? DEFAULT_PAGE_SIZE,
      filters: [{ type: "contract", contractIds: [contractId] }],
    });

    if (response.events.length === 0) {
      return 0;
    }

    // Normalize and publish events to Redis Stream
    let ingested = 0;
    for (const rawEvent of response.events) {
      const normalized = normalizeEvent(rawEvent);

      // Publish to Redis Stream (XADD with auto-ID)
      await this.redis.xadd(
        STREAM_KEY,
        "*",
        "contractId", normalized.contractId,
        "topic", normalized.topic,
        "data", JSON.stringify(normalized.data),
        "ledger", String(normalized.ledger),
        "txHash", normalized.txHash,
        "timestamp", normalized.timestamp,
      );
      ingested++;
    }

    // Save updated cursor — guarantees resume without reprocessing
    const newCursor: ContractEventCursor = {
      contractId,
      lastLedgerSequence: response.latestLedger,
      cursorToken: response.cursor,
    };
    await this.cursorStore.saveCursor(newCursor);

    this.log.debug("Ingested events for contract", {
      contractId,
      count: ingested,
      latestLedger: response.latestLedger,
    });

    return ingested;
  }

  /**
   * Get the current cursor for a contract (for monitoring/debugging).
   */
  async getCursor(contractId: string): Promise<ContractEventCursor | null> {
    return await this.cursorStore.loadCursor(contractId);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSorobanEventIngestionWorker(
  redis: Redis,
  config: SorobanRpcConfig,
  options?: { logger?: Logger },
): SorobanEventIngestionWorker {
  return new SorobanEventIngestionWorker(redis, config, options);
}

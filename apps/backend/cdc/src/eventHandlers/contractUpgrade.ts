/**
 * Soroban Contract Upgrade Event Listener — Governance Security (Issue #603)
 *
 * Monitors Soroban contract upgrade events and verifies new WASM bytecode hashes
 * against a governance-approved whitelist. Unverified upgrades trigger critical
 * security alerts and pause automated withdrawals.
 *
 * Event flow:
 *   1. Soroban ingestion worker emits `contract_upgrade` events to Redis stream
 *   2. This handler consumes events and validates `newWasmHash` against registry
 *   3. Verified upgrades → update contract configuration records
 *   4. Unverified upgrades → PagerDuty/Telegram alert + pause automated withdrawals
 */

import { createLogger, type Logger } from "@delegolabs/utils";
import { Redis } from "ioredis";
import type { Pool } from "pg";

// ---------------------------------------------------------------------------
// Local notification utilities (inlined to avoid cross-package dependency issues)
// ---------------------------------------------------------------------------

interface NotificationChannel {
  id: string;
  type: "pagerduty" | "slack" | "email" | "sms";
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

const notificationChannels = new Map<string, NotificationChannel>();

function registerChannel(channel: NotificationChannel): NotificationChannel {
  notificationChannels.set(channel.id, channel);
  return channel;
}

async function sendPagerDutyNotification(
  config: Record<string, unknown>,
  message: string,
  title: string
): Promise<{ success: boolean; error?: string }> {
  const routingKey = config.routingKey as string;
  if (!routingKey) {
    return { success: false, error: "No routing key configured" };
  }

  try {
    const payload = {
      routing_key: routingKey,
      event_action: "trigger",
      payload: {
        summary: title,
        severity: "critical",
        source: "delego-contract-upgrade-listener",
        custom_details: { message },
      },
    };

    const response = await fetch("https://events.pagerduty.com/v2/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function sendSlackNotification(
  config: Record<string, unknown>,
  message: string,
  title: string
): Promise<{ success: boolean; error?: string }> {
  const webhookUrl = config.webhookUrl as string;
  if (!webhookUrl) {
    return { success: false, error: "No webhook URL configured" };
  }

  try {
    const payload = {
      text: title,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: title },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: message },
        },
      ],
    };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function sendNotification(
  channelType: string,
  targetId: string,
  title: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  const channel = notificationChannels.get(targetId);

  if (!channel) {
    return { success: false, error: `Channel ${targetId} not found` };
  }

  if (!channel.enabled) {
    return { success: false, error: `Channel ${targetId} is disabled` };
  }

  let result: { success: boolean; error?: string };

  switch (channelType) {
    case "pagerduty":
      result = await sendPagerDutyNotification(channel.config, message, title);
      break;
    case "slack":
      result = await sendSlackNotification(channel.config, message, title);
      break;
    default:
      result = { success: false, error: `Unsupported channel type: ${channelType}` };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContractUpgradeEvent {
  contractAddress: string;
  oldWasmHash: string;
  newWasmHash: string;
  executedBy: string;
  ledgerSequence: number;
  timestamp: string;
  txHash: string;
  eventId: string;
}

export interface ApprovedWasmHash {
  contractAddress: string;
  wasmHash: string;
  approvedBy: string;           // Governance multisig address that approved
  approvedAt: string;           // ISO timestamp
  description?: string;         // Human-readable description (e.g., "v2.1.0 - fee reduction")
  governanceProposalId?: string; // Link to governance proposal
}

export interface ContractConfigRecord {
  contractAddress: string;
  currentWasmHash: string;
  lastUpgradeLedger: number;
  lastUpgradeTxHash: string;
  lastUpgradeAt: string;
  upgradeCount: number;
  status: "active" | "paused" | "quarantined";
  updatedAt: string;
}

export interface WithdrawalPauseState {
  contractAddress: string;
  paused: boolean;
  pausedAt: string | null;
  pausedBy: string | null;      // "contractUpgradeListener" | "manual" | etc.
  pauseReason: string | null;
  resumedAt: string | null;
  resumedBy: string | null;
}

export interface ContractUpgradeListenerConfig {
  /** Redis connection for consuming upgrade events */
  redis: Redis;
  /** PostgreSQL pool for persistent state */
  pgPool: Pool;
  /** Contract addresses to monitor for upgrades */
  monitoredContracts: string[];
  /** Initial approved WASM hashes (can be loaded from DB on startup) */
  initialApprovedHashes?: ApprovedWasmHash[];
  /** PagerDuty notification channel ID (must be registered) */
  pagerDutyChannelId?: string;
  /** Telegram notification channel ID (must be registered) */
  telegramChannelId?: string;
  /** Poll interval for checking new events (ms) */
  pollIntervalMs?: number;
  /** Consumer group name for Redis stream */
  consumerGroup?: string;
  /** Consumer name within the group */
  consumerName?: string;
  /** Logger instance */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UPGRADE_EVENT_TOPIC = "contract_upgrade";
const REDIS_STREAM_KEY = "soroban:events";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_CONSUMER_GROUP = "contract-upgrade-listener";

// ---------------------------------------------------------------------------
// Contract Upgrade Event Listener
// ---------------------------------------------------------------------------

export class ContractUpgradeListener {
  private readonly redis: Redis;
  private readonly pgPool: Pool;
  private readonly monitoredContracts: Set<string>;
  private readonly approvedHashes: Map<string, Set<string>>; // contractAddress -> Set<wasmHash>
  private readonly approvedHashDetails: Map<string, ApprovedWasmHash[]>; // contractAddress -> details
  private readonly config: Required<Omit<ContractUpgradeListenerConfig, "initialApprovedHashes">> &
    Pick<ContractUpgradeListenerConfig, "initialApprovedHashes">;
  private readonly log: Logger;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEventId = "0-0";

  constructor(config: ContractUpgradeListenerConfig) {
    this.redis = config.redis;
    this.pgPool = config.pgPool;
    this.monitoredContracts = new Set(config.monitoredContracts);
    this.approvedHashes = new Map();
    this.approvedHashDetails = new Map();
    this.config = {
      redis: config.redis,
      pgPool: config.pgPool,
      monitoredContracts: config.monitoredContracts,
      initialApprovedHashes: config.initialApprovedHashes ?? [],
      pagerDutyChannelId: config.pagerDutyChannelId ?? "pagerduty-critical",
      telegramChannelId: config.telegramChannelId ?? "telegram-security",
      pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      consumerGroup: config.consumerGroup ?? DEFAULT_CONSUMER_GROUP,
      consumerName: config.consumerName ?? `upgrade-listener-${process.pid}`,
      logger: config.logger ?? createLogger("cdc:contractUpgrade", process.env.LOG_LEVEL ?? "info"),
    };
    this.log = this.config.logger;

    // Load initial approved hashes
    for (const approved of this.config.initialApprovedHashes ?? []) {
      this.addApprovedHash(approved);
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the listener: initialize DB tables, load approved hashes, create consumer group, begin polling.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.log.warn("Contract upgrade listener already running");
      return;
    }

    this.log.info("Starting contract upgrade listener", {
      monitoredContracts: Array.from(this.monitoredContracts),
      approvedHashesCount: this.getApprovedHashCount(),
    });

    // Initialize database tables
    await this.initializeDatabase();

    // Load approved hashes from database
    await this.loadApprovedHashesFromDatabase();

    // Ensure Redis consumer group exists
    await this.ensureConsumerGroup();

    this.running = true;
    this.poll();
  }

  /**
   * Stop the listener gracefully.
   */
  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.log.info("Contract upgrade listener stopped");
  }

  // -------------------------------------------------------------------------
  // Database Initialization
  // -------------------------------------------------------------------------

  private async initializeDatabase(): Promise<void> {
    const client = await this.pgPool.connect();
    try {
      await client.query("BEGIN");

      // Table for approved WASM hashes (governance registry)
      await client.query(`
        CREATE TABLE IF NOT EXISTS contract_approved_wasm_hashes (
          id BIGSERIAL PRIMARY KEY,
          contract_address VARCHAR(255) NOT NULL,
          wasm_hash VARCHAR(64) NOT NULL,
          approved_by VARCHAR(255) NOT NULL,
          approved_at TIMESTAMPTZ NOT NULL,
          description TEXT,
          governance_proposal_id VARCHAR(255),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (contract_address, wasm_hash)
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_contract_approved_wasm_hashes_contract
        ON contract_approved_wasm_hashes (contract_address);
      `);

      // Table for contract configuration records
      await client.query(`
        CREATE TABLE IF NOT EXISTS contract_config_records (
          contract_address VARCHAR(255) PRIMARY KEY,
          current_wasm_hash VARCHAR(64) NOT NULL,
          last_upgrade_ledger BIGINT NOT NULL,
          last_upgrade_tx_hash VARCHAR(64) NOT NULL,
          last_upgrade_at TIMESTAMPTZ NOT NULL,
          upgrade_count BIGINT NOT NULL DEFAULT 0,
          status VARCHAR(32) NOT NULL DEFAULT 'active',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_contract_config_records_status
        ON contract_config_records (status);
      `);

      // Table for withdrawal pause state
      await client.query(`
        CREATE TABLE IF NOT EXISTS contract_withdrawal_pause_state (
          contract_address VARCHAR(255) PRIMARY KEY,
          paused BOOLEAN NOT NULL DEFAULT FALSE,
          paused_at TIMESTAMPTZ,
          paused_by VARCHAR(255),
          pause_reason TEXT,
          resumed_at TIMESTAMPTZ,
          resumed_by VARCHAR(255),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      await client.query("COMMIT");
      this.log.debug("Database tables initialized");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Approved Hash Management
  // -------------------------------------------------------------------------

  /**
   * Add an approved WASM hash to the in-memory registry and persist to database.
   * Called by governance automation when a multisig approves a new contract version.
   */
  async addApprovedHash(approved: ApprovedWasmHash): Promise<void> {
    // In-memory index
    const hashes = this.approvedHashes.get(approved.contractAddress) ?? new Set();
    hashes.add(approved.wasmHash);
    this.approvedHashes.set(approved.contractAddress, hashes);

    const details = this.approvedHashDetails.get(approved.contractAddress) ?? [];
    details.push(approved);
    this.approvedHashDetails.set(approved.contractAddress, details);

    // Persist to database
    await this.pgPool.query(
      `INSERT INTO contract_approved_wasm_hashes
         (contract_address, wasm_hash, approved_by, approved_at, description, governance_proposal_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (contract_address, wasm_hash) DO UPDATE SET
         approved_by = EXCLUDED.approved_by,
         approved_at = EXCLUDED.approved_at,
         description = EXCLUDED.description,
         governance_proposal_id = EXCLUDED.governance_proposal_id`,
      [
        approved.contractAddress,
        approved.wasmHash,
        approved.approvedBy,
        approved.approvedAt,
        approved.description ?? null,
        approved.governanceProposalId ?? null,
      ]
    );

    this.log.info("Approved WASM hash added", {
      contractAddress: approved.contractAddress,
      wasmHash: approved.wasmHash,
      approvedBy: approved.approvedBy,
    });
  }

  /**
   * Remove an approved WASM hash (e.g., if a version is deprecated).
   */
  async removeApprovedHash(contractAddress: string, wasmHash: string): Promise<void> {
    const hashes = this.approvedHashes.get(contractAddress);
    if (hashes) {
      hashes.delete(wasmHash);
    }

    const details = this.approvedHashDetails.get(contractAddress);
    if (details) {
      const idx = details.findIndex((d) => d.wasmHash === wasmHash);
      if (idx >= 0) details.splice(idx, 1);
    }

    await this.pgPool.query(
      `DELETE FROM contract_approved_wasm_hashes WHERE contract_address = $1 AND wasm_hash = $2`,
      [contractAddress, wasmHash]
    );

    this.log.info("Approved WASM hash removed", { contractAddress, wasmHash });
  }

  /**
   * Check if a WASM hash is approved for a contract.
   */
  isApproved(contractAddress: string, wasmHash: string): boolean {
    return this.approvedHashes.get(contractAddress)?.has(wasmHash) ?? false;
  }

  /**
   * Get all approved hashes for a contract.
   */
  getApprovedHashes(contractAddress: string): ApprovedWasmHash[] {
    return this.approvedHashDetails.get(contractAddress) ?? [];
  }

  /**
   * Get total count of approved hashes across all contracts.
   */
  getApprovedHashCount(): number {
    let count = 0;
    for (const hashes of this.approvedHashes.values()) {
      count += hashes.size;
    }
    return count;
  }

  /**
   * Load approved hashes from database on startup.
   */
  private async loadApprovedHashesFromDatabase(): Promise<void> {
    const res = await this.pgPool.query<{
      contract_address: string;
      wasm_hash: string;
      approved_by: string;
      approved_at: Date;
      description: string | null;
      governance_proposal_id: string | null;
    }>(`SELECT contract_address, wasm_hash, approved_by, approved_at, description, governance_proposal_id
        FROM contract_approved_wasm_hashes`);

    for (const row of res.rows) {
      const approved: ApprovedWasmHash = {
        contractAddress: row.contract_address,
        wasmHash: row.wasm_hash,
        approvedBy: row.approved_by,
        approvedAt: row.approved_at.toISOString(),
        description: row.description ?? undefined,
        governanceProposalId: row.governance_proposal_id ?? undefined,
      };
      this.addApprovedHashToMemory(approved);
    }

    this.log.info("Loaded approved WASM hashes from database", { count: this.getApprovedHashCount() });
  }

  private addApprovedHashToMemory(approved: ApprovedWasmHash): void {
    const hashes = this.approvedHashes.get(approved.contractAddress) ?? new Set();
    hashes.add(approved.wasmHash);
    this.approvedHashes.set(approved.contractAddress, hashes);

    const details = this.approvedHashDetails.get(approved.contractAddress) ?? [];
    details.push(approved);
    this.approvedHashDetails.set(approved.contractAddress, details);
  }

  // -------------------------------------------------------------------------
  // Redis Stream Consumption
  // -------------------------------------------------------------------------

  private async ensureConsumerGroup(): Promise<void> {
    try {
      await this.redis.xgroup("CREATE", REDIS_STREAM_KEY, this.config.consumerGroup, "0", "MKSTREAM");
      this.log.debug("Created Redis consumer group", { group: this.config.consumerGroup });
    } catch (err) {
      // Group may already exist
      if (err instanceof Error && !err.message.includes("BUSYGROUP")) {
        throw err;
      }
      this.log.debug("Consumer group already exists", { group: this.config.consumerGroup });
    }
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      await this.consumeEvents();
    } catch (err) {
      this.log.error("Error consuming upgrade events", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (this.running) {
        this.pollTimer = setTimeout(() => this.poll(), this.config.pollIntervalMs);
      }
    }
  }

  private async consumeEvents(): Promise<void> {
    const result = await this.redis.xreadgroup(
      "GROUP",
      this.config.consumerGroup,
      this.config.consumerName,
      "COUNT",
      "50",
      "BLOCK",
      "5000",
      "STREAMS",
      REDIS_STREAM_KEY,
      ">"
    ) as Array<[string, Array<[string, string[]]>]> | null;

    if (!result) return;

    for (const [_stream, messages] of result) {
      for (const [messageId, fields] of messages) {
        this.lastEventId = messageId;
        await this.processMessage(messageId, fields);
      }
    }
  }

  private async processMessage(messageId: string, fields: string[]): Promise<void> {
    // Parse Redis stream message (key-value pairs)
    const data: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      data[fields[i]] = fields[i + 1];
    }

    // Check if this is a contract upgrade event
    if (data.topic !== UPGRADE_EVENT_TOPIC) {
      // Acknowledge non-upgrade events to avoid reprocessing
      await this.redis.xack(REDIS_STREAM_KEY, this.config.consumerGroup, messageId);
      return;
    }

    // Only process events for monitored contracts
    if (!this.monitoredContracts.has(data.contractId)) {
      await this.redis.xack(REDIS_STREAM_KEY, this.config.consumerGroup, messageId);
      return;
    }

    try {
      const event = this.parseUpgradeEvent(data);
      await this.handleUpgradeEvent(event);
      await this.redis.xack(REDIS_STREAM_KEY, this.config.consumerGroup, messageId);
    } catch (err) {
      this.log.error("Failed to process upgrade event", {
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't ack - let it be redelivered
      throw err;
    }
  }

  private parseUpgradeEvent(data: Record<string, string>): ContractUpgradeEvent {
    const eventData = JSON.parse(data.data) as Record<string, unknown>;

    return {
      contractAddress: data.contractId,
      oldWasmHash: String(eventData.old_wasm_hash ?? eventData.oldWasmHash ?? ""),
      newWasmHash: String(eventData.new_wasm_hash ?? eventData.newWasmHash ?? ""),
      executedBy: String(eventData.executed_by ?? eventData.executedBy ?? ""),
      ledgerSequence: Number(data.ledger),
      timestamp: data.timestamp,
      txHash: data.txHash,
      eventId: data.eventId,
    };
  }

  // -------------------------------------------------------------------------
  // Event Handling
  // -------------------------------------------------------------------------

  private async handleUpgradeEvent(event: ContractUpgradeEvent): Promise<void> {
    this.log.info("Processing contract upgrade event", {
      contractAddress: event.contractAddress,
      oldWasmHash: event.oldWasmHash,
      newWasmHash: event.newWasmHash,
      executedBy: event.executedBy,
      ledgerSequence: event.ledgerSequence,
    });

    const isApproved = this.isApproved(event.contractAddress, event.newWasmHash);

    if (isApproved) {
      await this.handleVerifiedUpgrade(event);
    } else {
      await this.handleUnverifiedUpgrade(event);
    }
  }

  private async handleVerifiedUpgrade(event: ContractUpgradeEvent): Promise<void> {
    this.log.info("Verified contract upgrade detected", {
      contractAddress: event.contractAddress,
      newWasmHash: event.newWasmHash,
      ledgerSequence: event.ledgerSequence,
    });

    // Update contract configuration record
    await this.updateContractConfig(event);

    // Ensure withdrawals are not paused for this contract (may have been paused by previous unverified upgrade)
    const pauseState = await this.getWithdrawalPauseState(event.contractAddress);
    if (pauseState.paused && pauseState.pausedBy === "contractUpgradeListener") {
      this.log.info("Resuming withdrawals after verified upgrade", {
        contractAddress: event.contractAddress,
      });
      await this.resumeWithdrawals(event.contractAddress, "contractUpgradeListener", "Verified upgrade applied");
    }
  }

  private async handleUnverifiedUpgrade(event: ContractUpgradeEvent): Promise<void> {
    this.log.error("UNVERIFIED CONTRACT UPGRADE DETECTED — SECURITY ALERT", {
      contractAddress: event.contractAddress,
      oldWasmHash: event.oldWasmHash,
      newWasmHash: event.newWasmHash,
      executedBy: event.executedBy,
      ledgerSequence: event.ledgerSequence,
      txHash: event.txHash,
    });

    // 1. Pause automated withdrawals for this contract
    await this.pauseWithdrawals(
      event.contractAddress,
      "contractUpgradeListener",
      `Unverified WASM hash deployed: ${event.newWasmHash} (approved hashes: ${Array.from(this.approvedHashes.get(event.contractAddress) ?? []).join(", ") || "none"})`
    );

    // 2. Update contract status to quarantined
    await this.updateContractStatus(event.contractAddress, "quarantined");

    // 3. Send critical security alerts
    await this.sendSecurityAlerts(event);
  }

  // -------------------------------------------------------------------------
  // Contract Configuration Management
  // -------------------------------------------------------------------------

  private async updateContractConfig(event: ContractUpgradeEvent): Promise<void> {
    await this.pgPool.query(
      `INSERT INTO contract_config_records
         (contract_address, current_wasm_hash, last_upgrade_ledger, last_upgrade_tx_hash, last_upgrade_at, upgrade_count, status)
       VALUES ($1, $2, $3, $4, $5, 1, 'active')
       ON CONFLICT (contract_address) DO UPDATE SET
         current_wasm_hash = EXCLUDED.current_wasm_hash,
         last_upgrade_ledger = EXCLUDED.last_upgrade_ledger,
         last_upgrade_tx_hash = EXCLUDED.last_upgrade_tx_hash,
         last_upgrade_at = EXCLUDED.last_upgrade_at,
         upgrade_count = contract_config_records.upgrade_count + 1,
         status = 'active',
         updated_at = NOW()`,
      [
        event.contractAddress,
        event.newWasmHash,
        event.ledgerSequence,
        event.txHash,
        event.timestamp,
      ]
    );

    this.log.debug("Contract config updated", { contractAddress: event.contractAddress });
  }

  private async updateContractStatus(contractAddress: string, status: "active" | "paused" | "quarantined"): Promise<void> {
    await this.pgPool.query(
      `UPDATE contract_config_records SET status = $2, updated_at = NOW() WHERE contract_address = $1`,
      [contractAddress, status]
    );
  }

  async getContractConfig(contractAddress: string): Promise<ContractConfigRecord | null> {
    const res = await this.pgPool.query<{
      contract_address: string;
      current_wasm_hash: string;
      last_upgrade_ledger: number;
      last_upgrade_tx_hash: string;
      last_upgrade_at: Date;
      upgrade_count: number;
      status: string;
      updated_at: Date;
    }>(`SELECT * FROM contract_config_records WHERE contract_address = $1`, [contractAddress]);

    if (res.rows.length === 0) return null;

    const row = res.rows[0];
    return {
      contractAddress: row.contract_address,
      currentWasmHash: row.current_wasm_hash,
      lastUpgradeLedger: row.last_upgrade_ledger,
      lastUpgradeTxHash: row.last_upgrade_tx_hash,
      lastUpgradeAt: row.last_upgrade_at.toISOString(),
      upgradeCount: row.upgrade_count,
      status: row.status as "active" | "paused" | "quarantined",
      updatedAt: row.updated_at.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Withdrawal Pause Management
  // -------------------------------------------------------------------------

  private async pauseWithdrawals(
    contractAddress: string,
    pausedBy: string,
    pauseReason: string
  ): Promise<void> {
    await this.pgPool.query(
      `INSERT INTO contract_withdrawal_pause_state
         (contract_address, paused, paused_at, paused_by, pause_reason)
       VALUES ($1, TRUE, NOW(), $2, $3)
       ON CONFLICT (contract_address) DO UPDATE SET
         paused = TRUE,
         paused_at = NOW(),
         paused_by = EXCLUDED.paused_by,
         pause_reason = EXCLUDED.pause_reason,
         updated_at = NOW()`,
      [contractAddress, pausedBy, pauseReason]
    );

    this.log.warn("Automated withdrawals paused", { contractAddress, pausedBy, pauseReason });
  }

  async resumeWithdrawals(
    contractAddress: string,
    resumedBy: string,
    resumeReason: string
  ): Promise<void> {
    await this.pgPool.query(
      `UPDATE contract_withdrawal_pause_state
       SET paused = FALSE,
           resumed_at = NOW(),
           resumed_by = $2,
           updated_at = NOW()
       WHERE contract_address = $1`,
      [contractAddress, resumedBy]
    );

    // Also update contract status back to active if it was quarantined
    await this.updateContractStatus(contractAddress, "active");

    this.log.info("Automated withdrawals resumed", { contractAddress, resumedBy, resumeReason });
  }

  async getWithdrawalPauseState(contractAddress: string): Promise<WithdrawalPauseState> {
    const res = await this.pgPool.query<{
      contract_address: string;
      paused: boolean;
      paused_at: Date | null;
      paused_by: string | null;
      pause_reason: string | null;
      resumed_at: Date | null;
      resumed_by: string | null;
    }>(`SELECT * FROM contract_withdrawal_pause_state WHERE contract_address = $1`, [contractAddress]);

    if (res.rows.length === 0) {
      return {
        contractAddress,
        paused: false,
        pausedAt: null,
        pausedBy: null,
        pauseReason: null,
        resumedAt: null,
        resumedBy: null,
      };
    }

    const row = res.rows[0];
    return {
      contractAddress: row.contract_address,
      paused: row.paused,
      pausedAt: row.paused_at?.toISOString() ?? null,
      pausedBy: row.paused_by ?? null,
      pauseReason: row.pause_reason ?? null,
      resumedAt: row.resumed_at?.toISOString() ?? null,
      resumedBy: row.resumed_by ?? null,
    };
  }

  /**
   * Check if withdrawals are paused for a contract (for use by withdrawal services).
   */
  async areWithdrawalsPaused(contractAddress: string): Promise<boolean> {
    const state = await this.getWithdrawalPauseState(contractAddress);
    return state.paused;
  }

  // -------------------------------------------------------------------------
  // Security Alerts
  // -------------------------------------------------------------------------

  private async sendSecurityAlerts(event: ContractUpgradeEvent): Promise<void> {
    const title = `🚨 CRITICAL: Unverified Contract Upgrade — ${event.contractAddress}`;
    const message = this.formatSecurityAlertMessage(event);

    // Send to PagerDuty
    if (this.config.pagerDutyChannelId) {
      try {
        await sendNotification("pagerduty", this.config.pagerDutyChannelId, title, message);
        this.log.info("PagerDuty alert sent for unverified upgrade", { contractAddress: event.contractAddress });
      } catch (err) {
        this.log.error("Failed to send PagerDuty alert", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Send to Telegram
    if (this.config.telegramChannelId) {
      try {
        await sendNotification("slack", this.config.telegramChannelId, title, message); // Using slack webhook for Telegram
        this.log.info("Telegram alert sent for unverified upgrade", { contractAddress: event.contractAddress });
      } catch (err) {
        this.log.error("Failed to send Telegram alert", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private formatSecurityAlertMessage(event: ContractUpgradeEvent): string {
    const approvedHashes = Array.from(this.approvedHashes.get(event.contractAddress) ?? []);
    return [
      `**Contract:** \`${event.contractAddress}\``,
      `**Old WASM Hash:** \`${event.oldWasmHash}\``,
      `**New WASM Hash:** \`${event.newWasmHash}\``,
      `**Executed By:** \`${event.executedBy}\``,
      `**Ledger:** ${event.ledgerSequence}`,
      `**Transaction:** \`${event.txHash}\``,
      `**Event ID:** \`${event.eventId}\``,
      "",
      `**Approved Hashes:** ${approvedHashes.length > 0 ? approvedHashes.map((h) => `\`${h}\``).join(", ") : "NONE"}`,
      "",
      `⚠️ **AUTOMATED WITHDRAWALS PAUSED** for this contract.`,
      `Manual governance intervention required to verify and resume.`,
    ].join("\n");
  }

  // -------------------------------------------------------------------------
  // Health & Monitoring
  // -------------------------------------------------------------------------

  getStatus(): {
    running: boolean;
    monitoredContracts: string[];
    approvedHashesCount: number;
    lastEventId: string;
  } {
    return {
      running: this.running,
      monitoredContracts: Array.from(this.monitoredContracts),
      approvedHashesCount: this.getApprovedHashCount(),
      lastEventId: this.lastEventId,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory Function
// ---------------------------------------------------------------------------

export interface CreateContractUpgradeListenerOptions {
  redis: Redis;
  pgPool: Pool;
  monitoredContracts: string[];
  initialApprovedHashes?: ApprovedWasmHash[];
  pagerDutyChannelId?: string;
  telegramChannelId?: string;
  pollIntervalMs?: number;
  consumerGroup?: string;
  consumerName?: string;
  logger?: Logger;
}

/**
 * Create and configure a ContractUpgradeListener with notification channels.
 */
export async function createContractUpgradeListener(
  options: CreateContractUpgradeListenerOptions
): Promise<ContractUpgradeListener> {
  const {
    redis,
    pgPool,
    monitoredContracts,
    initialApprovedHashes,
    pagerDutyChannelId,
    telegramChannelId,
    pollIntervalMs,
    consumerGroup,
    consumerName,
    logger,
  } = options;

  // Register notification channels if provided via environment
  const pagerDutyRoutingKey = process.env.PAGERDUTY_ROUTING_KEY;
  const telegramWebhookUrl = process.env.TELEGRAM_WEBHOOK_URL;

  if (pagerDutyRoutingKey && pagerDutyChannelId) {
    registerChannel({
      id: pagerDutyChannelId,
      type: "pagerduty",
      name: "PagerDuty Critical Alerts",
      config: { routingKey: pagerDutyRoutingKey },
      enabled: true,
    });
  }

  if (telegramWebhookUrl && telegramChannelId) {
    registerChannel({
      id: telegramChannelId,
      type: "slack", // Using slack webhook format for Telegram compatibility
      name: "Telegram Security Alerts",
      config: { webhookUrl: telegramWebhookUrl },
      enabled: true,
    });
  }

  const listener = new ContractUpgradeListener({
    redis,
    pgPool,
    monitoredContracts,
    initialApprovedHashes,
    pagerDutyChannelId,
    telegramChannelId,
    pollIntervalMs,
    consumerGroup,
    consumerName,
    logger,
  });

  return listener;
}
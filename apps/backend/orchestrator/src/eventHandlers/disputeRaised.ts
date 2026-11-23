import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";
import { Pool, type QueryResultRow } from "pg";
import { createLogger, type Logger } from "@delegolabs/utils";

const log = createLogger("orchestrator:dispute-raised", process.env.LOG_LEVEL ?? "info");

export interface DisputeRaisedPayload {
  orderId: string;
  disputeId: string;
  initiatorAddress: string;
  disputeReasonCode: number;
  evidenceHash: string;
  ledgerSequence: number;
}

export interface QueryResultLike<T extends QueryResultRow = QueryResultRow> {
  rows: T[];
  rowCount?: number | null;
}

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResultLike<T>>;
}

export interface TransactionalDb extends Queryable {
  connect?: () => Promise<Queryable & { release?: () => void }>;
}

export interface ArbiterNotificationJobData {
  event: "dispute.raised";
  audience: "arbiters";
  orderId: string;
  disputeId: string;
  initiatorAddress: string;
  disputeReasonCode: number;
  evidenceHash: string;
  evidenceUrl: string;
  ledgerSequence: number;
  occurredAt: string;
}

export interface ArbiterNotificationQueue {
  add(
    name: string,
    data: ArbiterNotificationJobData,
    opts?: JobsOptions,
  ): Promise<unknown>;
}

export interface SettlementTimerFreezeInput {
  orderId: string;
  disputeId: string;
  escrowId?: string;
}

export interface SettlementTimerFreezeResult {
  queueNames: string[];
  removedJobIds: string[];
}

export interface SettlementTimerFreezer {
  freeze(input: SettlementTimerFreezeInput): Promise<SettlementTimerFreezeResult>;
}

export type EvidenceUrlResolver = (
  client: Queryable,
  payload: DisputeRaisedPayload,
) => Promise<string | null | undefined>;

export interface DisputeRaisedHandlerDeps {
  db: TransactionalDb;
  arbiterQueue: ArbiterNotificationQueue;
  settlementTimerFreezer?: SettlementTimerFreezer;
  evidenceUrlResolver?: EvidenceUrlResolver;
  logger?: Logger;
}

export interface DisputeRaisedHandlerResult {
  orderId: string;
  disputeId: string;
  orderStatus: "disputed";
  evidenceHash: string;
  evidenceUrl: string;
  escrowId?: string;
  settlementTimerFreeze: SettlementTimerFreezeResult;
  arbiterNotificationJobId?: string;
}

export const ARBITER_NOTIFICATION_QUEUE = "arbiter-notifications";
export const ARBITER_NOTIFICATION_JOB = "dispute-raised";
export const DEFAULT_SETTLEMENT_TIMER_QUEUES = [
  "escrow-auto-release",
  "escrow-auto-release-trigger",
] as const;

export class DisputeRaisedValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisputeRaisedValidationError";
  }
}

export class DisputeRaisedOrderNotFoundError extends Error {
  constructor(orderId: string) {
    super(`Order not found for dispute event: ${orderId}`);
    this.name = "DisputeRaisedOrderNotFoundError";
  }
}

interface OrderRow extends QueryResultRow {
  id: string;
  user_id: string;
  merchant_id: string | null;
  escrow_contract_id: string | null;
  status: string;
}

interface PaymentEscrowRow extends QueryResultRow {
  escrow_id: string | null;
}

interface DisputeEvidenceRow extends QueryResultRow {
  files: unknown;
}

function validatePayload(payload: DisputeRaisedPayload): DisputeRaisedPayload {
  const requiredStrings: Array<keyof DisputeRaisedPayload> = [
    "orderId",
    "disputeId",
    "initiatorAddress",
    "evidenceHash",
  ];

  for (const field of requiredStrings) {
    const value = payload[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new DisputeRaisedValidationError(`${field} is required`);
    }
  }

  if (!Number.isFinite(payload.disputeReasonCode)) {
    throw new DisputeRaisedValidationError("disputeReasonCode must be a finite number");
  }
  if (!Number.isSafeInteger(payload.ledgerSequence) || payload.ledgerSequence < 0) {
    throw new DisputeRaisedValidationError("ledgerSequence must be a non-negative safe integer");
  }

  return {
    orderId: payload.orderId.trim(),
    disputeId: payload.disputeId.trim(),
    initiatorAddress: payload.initiatorAddress.trim(),
    disputeReasonCode: payload.disputeReasonCode,
    evidenceHash: payload.evidenceHash.trim(),
    ledgerSequence: payload.ledgerSequence,
  };
}

async function withTransaction<T>(
  db: TransactionalDb,
  fn: (client: Queryable) => Promise<T>,
): Promise<T> {
  if (typeof db.connect === "function") {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release?.();
    }
  }

  await db.query("BEGIN");
  try {
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function ipfsGateway(env: Record<string, string | undefined>): string {
  return (env.IPFS_GATEWAY_URL ?? "https://ipfs.io").replace(/\/+$/, "");
}

function isIpfsCid(value: string): boolean {
  return (
    /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(value) ||
    /^b[a-z2-7]{20,}$/i.test(value)
  );
}

function normalizeIpfsReference(reference: string, env: Record<string, string | undefined>): string {
  const withoutScheme = reference.replace(/^ipfs:\/\//i, "");
  const cid = withoutScheme.replace(/^\/?ipfs\//i, "").replace(/^\/+/, "");
  return joinUrl(ipfsGateway(env), `ipfs/${cid}`);
}

function renderUrlTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
    const value = values[key];
    return value === undefined ? "" : encodeURIComponent(String(value));
  });
}

function buildStorageObjectUrl(
  objectKey: string,
  env: Record<string, string | undefined>,
): string | null {
  const bucket = env.STORAGE_BUCKET_NAME;
  if (!bucket) return null;

  const endpoint = env.STORAGE_ENDPOINT;
  if (endpoint) {
    try {
      const endpointUrl = new URL(endpoint);
      return `${endpointUrl.protocol}//${endpointUrl.hostname}/${bucket}/${objectKey}`;
    } catch {
      return null;
    }
  }

  const region = env.STORAGE_REGION ?? "auto";
  return `https://${bucket}.s3.${region}.amazonaws.com/${objectKey}`;
}

export function buildDisputeEvidenceUrl(
  payload: Pick<DisputeRaisedPayload, "orderId" | "disputeId" | "evidenceHash">,
  env: Record<string, string | undefined> = process.env,
): string {
  const reference = payload.evidenceHash.trim();
  if (/^https?:\/\//i.test(reference)) return reference;

  const template = env.DISPUTE_EVIDENCE_URL_TEMPLATE;
  if (template) {
    return renderUrlTemplate(template, {
      evidenceHash: reference,
      disputeId: payload.disputeId,
      orderId: payload.orderId,
    });
  }

  if (reference.startsWith("ipfs://") || isIpfsCid(reference)) {
    return normalizeIpfsReference(reference, env);
  }

  const storageUrl = buildStorageObjectUrl(reference, env);
  if (storageUrl) return storageUrl;

  const paymentsBase = env.PAYMENTS_URL ?? env.PAYMENTS_SERVICE_URL;
  if (paymentsBase) {
    return joinUrl(
      paymentsBase,
      `disputes/${encodeURIComponent(payload.disputeId)}?evidenceHash=${encodeURIComponent(reference)}`,
    );
  }

  const appBase = env.GATEWAY_PUBLIC_URL ?? env.PUBLIC_APP_URL ?? env.GATEWAY_URL;
  if (appBase) {
    return joinUrl(
      appBase,
      `api/v1/disputes/${encodeURIComponent(payload.disputeId)}/evidence?hash=${encodeURIComponent(reference)}`,
    );
  }

  return normalizeIpfsReference(reference, env);
}

function extractEvidenceFiles(files: unknown): string[] {
  if (Array.isArray(files)) {
    return files
      .filter((file): file is string => typeof file === "string")
      .map((file) => file.trim())
      .filter((file) => file.length > 0);
  }
  if (typeof files === "string") {
    try {
      const parsed = JSON.parse(files) as unknown;
      return extractEvidenceFiles(parsed);
    } catch {
      return [];
    }
  }
  return [];
}

function directEvidenceUrl(
  reference: string,
  payload: DisputeRaisedPayload,
  env: Record<string, string | undefined>,
): string | null {
  const normalized = buildDisputeEvidenceUrl(
    { ...payload, evidenceHash: reference },
    env,
  );
  return /^https?:\/\//i.test(normalized) ? normalized : null;
}

export async function findStoredDisputeEvidenceUrl(
  client: Queryable,
  payload: DisputeRaisedPayload,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  const { rows } = await client.query<DisputeEvidenceRow>(
    `SELECT files
       FROM dispute_evidence
      WHERE integrity_hash = $1
         OR strpos(files::text, $1) > 0
      ORDER BY submitted_at DESC
      LIMIT 5`,
    [payload.evidenceHash],
  );

  for (const row of rows) {
    for (const file of extractEvidenceFiles(row.files)) {
      const url = directEvidenceUrl(file, payload, env);
      if (url) return url;
    }
  }
  return null;
}

function redisConnectionFromUrl(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined,
  };
}

export class BullMQArbiterNotificationQueue implements ArbiterNotificationQueue {
  private queue: Queue<ArbiterNotificationJobData> | null = null;

  constructor(private readonly connection: ConnectionOptions) {}

  async add(
    name: string,
    data: ArbiterNotificationJobData,
    opts: JobsOptions = {},
  ): Promise<unknown> {
    this.queue ??= new Queue<ArbiterNotificationJobData>(ARBITER_NOTIFICATION_QUEUE, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    });
    return this.queue.add(name, data, opts);
  }

  async close(): Promise<void> {
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
  }
}

interface TimerQueueJob {
  id?: string;
  data?: unknown;
  remove(): Promise<void>;
}

interface TimerQueue {
  getJobs(types?: string[]): Promise<TimerQueueJob[]>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function jobMatchesOrder(job: TimerQueueJob, input: SettlementTimerFreezeInput): boolean {
  const data = isRecord(job.data) ? job.data : {};
  return (
    data.orderId === input.orderId ||
    (input.escrowId !== undefined && data.escrowId === input.escrowId)
  );
}

export class BullMQSettlementTimerFreezer implements SettlementTimerFreezer {
  private readonly queues = new Map<string, TimerQueue>();

  constructor(
    private readonly connection: ConnectionOptions,
    private readonly queueNames: readonly string[] = DEFAULT_SETTLEMENT_TIMER_QUEUES,
  ) {}

  private getQueue(name: string): TimerQueue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection }) as unknown as TimerQueue;
      this.queues.set(name, queue);
    }
    return queue;
  }

  async freeze(input: SettlementTimerFreezeInput): Promise<SettlementTimerFreezeResult> {
    const removedJobIds: string[] = [];

    for (const queueName of this.queueNames) {
      const queue = this.getQueue(queueName);
      const jobs = await queue.getJobs(["waiting", "delayed", "paused"]);
      for (const job of jobs) {
        if (!jobMatchesOrder(job, input)) continue;
        await job.remove();
        if (job.id) removedJobIds.push(job.id);
      }
    }

    return { queueNames: [...this.queueNames], removedJobIds };
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }
}

export class DisputeRaisedEventHandler {
  private readonly logger: Logger;

  constructor(private readonly deps: DisputeRaisedHandlerDeps) {
    this.logger = deps.logger ?? log;
  }

  async handle(payload: DisputeRaisedPayload): Promise<DisputeRaisedHandlerResult> {
    const normalized = validatePayload(payload);

    const persisted = await withTransaction(this.deps.db, async (client) => {
      const orderResult = await client.query<OrderRow>(
        `SELECT id, user_id, merchant_id, escrow_contract_id, status
           FROM orders
          WHERE id = $1
          FOR UPDATE`,
        [normalized.orderId],
      );
      const order = orderResult.rows[0];
      if (!order) throw new DisputeRaisedOrderNotFoundError(normalized.orderId);

      const paymentResult = await client.query<PaymentEscrowRow>(
        `SELECT escrow_id
           FROM payment_records
          WHERE order_id = $1
          ORDER BY updated_at DESC
          LIMIT 1`,
        [normalized.orderId],
      );
      const escrowId = paymentResult.rows[0]?.escrow_id || order.escrow_contract_id || undefined;

      await client.query(
        `UPDATE orders
            SET status = 'disputed',
                evidence_hash = $2,
                dispute_id = $3,
                dispute_reason_code = $4,
                dispute_ledger_sequence = $5,
                disputed_at = NOW(),
                updated_at = NOW()
          WHERE id = $1`,
        [
          normalized.orderId,
          normalized.evidenceHash,
          normalized.disputeId,
          normalized.disputeReasonCode,
          normalized.ledgerSequence,
        ],
      );

      await client.query(
        `UPDATE payment_records
            SET status = 'disputed',
                updated_at = NOW()
          WHERE order_id = $1
            AND status NOT IN ('released', 'refunded', 'failed')`,
        [normalized.orderId],
      );

      const evidenceUrl = await this.resolveEvidenceUrl(client, normalized);

      return { order, escrowId, evidenceUrl };
    });

    const freezeResult = this.deps.settlementTimerFreezer
      ? await this.deps.settlementTimerFreezer.freeze({
          orderId: normalized.orderId,
          disputeId: normalized.disputeId,
          escrowId: persisted.escrowId,
        })
      : { queueNames: [], removedJobIds: [] };

    const notification: ArbiterNotificationJobData = {
      event: "dispute.raised",
      audience: "arbiters",
      orderId: normalized.orderId,
      disputeId: normalized.disputeId,
      initiatorAddress: normalized.initiatorAddress,
      disputeReasonCode: normalized.disputeReasonCode,
      evidenceHash: normalized.evidenceHash,
      evidenceUrl: persisted.evidenceUrl,
      ledgerSequence: normalized.ledgerSequence,
      occurredAt: new Date().toISOString(),
    };

    const queued = await this.deps.arbiterQueue.add(
      ARBITER_NOTIFICATION_JOB,
      notification,
      {
        jobId: `dispute-raised:${normalized.disputeId}`,
        attempts: 5,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );
    const arbiterNotificationJobId =
      typeof queued === "object" && queued !== null && "id" in queued
        ? String((queued as { id?: unknown }).id)
        : undefined;

    this.logger.info("Dispute raised event processed", {
      orderId: normalized.orderId,
      disputeId: normalized.disputeId,
      evidenceUrl: persisted.evidenceUrl,
      removedSettlementJobs: freezeResult.removedJobIds.length,
    });

    return {
      orderId: normalized.orderId,
      disputeId: normalized.disputeId,
      orderStatus: "disputed",
      evidenceHash: normalized.evidenceHash,
      evidenceUrl: persisted.evidenceUrl,
      escrowId: persisted.escrowId,
      settlementTimerFreeze: freezeResult,
      arbiterNotificationJobId,
    };
  }

  private async resolveEvidenceUrl(
    client: Queryable,
    payload: DisputeRaisedPayload,
  ): Promise<string> {
    try {
      const resolved = this.deps.evidenceUrlResolver
        ? await this.deps.evidenceUrlResolver(client, payload)
        : await findStoredDisputeEvidenceUrl(client, payload);
      if (resolved) {
        const normalized = resolved.startsWith("ipfs://")
          ? buildDisputeEvidenceUrl({ ...payload, evidenceHash: resolved })
          : resolved;
        if (/^https?:\/\//i.test(normalized)) return normalized;
      }
    } catch (error) {
      this.logger.warn("Stored dispute evidence lookup failed; using evidence hash URL", {
        disputeId: payload.disputeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return buildDisputeEvidenceUrl(payload);
  }
}

export const SOROBAN_EVENT_STREAM = "soroban:events";
export const DISPUTE_RAISED_CONSUMER_GROUP = "orchestrator-dispute-raised";

const DISPUTE_RAISED_TOPICS = new Set([
  "disputeraised",
  "disputeopened",
  "disputeraisedonchain",
  "disputeopenedonchain",
]);

export type RedisStreamClient = Pick<
  import("ioredis").Redis,
  "xgroup" | "xreadgroup" | "xack"
>;

function streamFieldsToRecord(fields: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let index = 0; index < fields.length; index += 2) {
    record[fields[index]] = fields[index + 1] ?? "";
  }
  return record;
}

export function normalizeDisputeStreamTopic(topic: string | undefined): string {
  return (topic ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isDisputeRaisedStreamTopic(topic: string | undefined): boolean {
  return DISPUTE_RAISED_TOPICS.has(normalizeDisputeStreamTopic(topic));
}

function disputeEventData(fields: Record<string, string>): Record<string, unknown> {
  if (!fields.data) return {};
  try {
    const parsed = JSON.parse(fields.data) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

export function disputeRaisedPayloadFromStreamFields(
  fields: string[],
): DisputeRaisedPayload | null {
  const record = streamFieldsToRecord(fields);
  if (!isDisputeRaisedStreamTopic(record.topic)) return null;

  let data = disputeEventData(record);
  for (const key of ["payload", "dispute", "event", "data"] as const) {
    const nested = data[key];
    if (isRecord(nested) && !Array.isArray(nested)) {
      data = { ...nested, ...data };
    }
  }
  const orderId = firstString(data.orderId, data.order_id, data.orderID, data.order, record.orderId, record.order_id);
  const disputeId = firstString(data.disputeId, data.dispute_id, data.disputeID, record.disputeId, record.dispute_id);
  const initiatorAddress = firstString(
    data.initiatorAddress,
    data.initiator_address,
    data.initiator,
    data.raisedBy,
    data.raised_by,
    data.sender,
    data.from,
    data.buyerAddress,
    data.buyer_address,
    data.buyer,
    data.account,
    data.address,
    record.initiatorAddress,
    record.initiator_address,
  );
  const evidenceHash = firstString(
    data.evidenceHash,
    data.evidence_hash,
    data.evidenceCid,
    data.evidence_cid,
    data.proofHash,
    data.proof_hash,
    data.evidence,
    data.evidenceUri,
    data.evidenceURL,
    data.evidence_url,
    data.cid,
    record.evidenceHash,
    record.evidence_hash,
  );
  const disputeReasonCode = firstNumber(
    data.disputeReasonCode,
    data.dispute_reason_code,
    data.reasonCode,
    data.reason_code,
    data.reason,
    record.disputeReasonCode,
    record.dispute_reason_code,
    record.reasonCode,
    record.reason_code,
  );
  const ledgerSequence = firstNumber(
    data.ledgerSequence,
    data.ledger_sequence,
    data.ledger,
    record.ledgerSequence,
    record.ledger_sequence,
    record.ledger,
  );

  if (!orderId || !disputeId || !initiatorAddress || !evidenceHash) return null;
  if (disputeReasonCode === undefined || ledgerSequence === undefined) return null;

  return {
    orderId,
    disputeId,
    initiatorAddress,
    disputeReasonCode,
    evidenceHash,
    ledgerSequence,
  };
}

export interface DisputeRaisedStreamListenerConfig {
  redis: RedisStreamClient;
  handler: DisputeRaisedEventHandler;
  streamKey?: string;
  consumerGroup?: string;
  consumerName?: string;
  pollIntervalMs?: number;
  blockMs?: number;
  pendingRead?: boolean;
  logger?: Logger;
}

export class DisputeRaisedStreamListener {
  private readonly redis: RedisStreamClient;
  private readonly handler: DisputeRaisedEventHandler;
  private readonly streamKey: string;
  private readonly consumerGroup: string;
  private readonly consumerName: string;
  private readonly pollIntervalMs: number;
  private readonly blockMs: number;
  private readonly pendingRead: boolean;
  private readonly logger: Logger;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: DisputeRaisedStreamListenerConfig) {
    this.redis = config.redis;
    this.handler = config.handler;
    this.streamKey = config.streamKey ?? SOROBAN_EVENT_STREAM;
    this.consumerGroup = config.consumerGroup ?? DISPUTE_RAISED_CONSUMER_GROUP;
    this.consumerName = config.consumerName ?? `dispute-raised-${process.pid}`;
    this.pollIntervalMs = config.pollIntervalMs ?? 100;
    this.blockMs = config.blockMs ?? 500;
    this.pendingRead = config.pendingRead ?? true;
    this.logger = config.logger ?? log;
  }

  async start(): Promise<void> {
    if (this.running) return;
    try {
      await this.redis.xgroup(
        "CREATE",
        this.streamKey,
        this.consumerGroup,
        "0",
        "MKSTREAM",
      );
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("BUSYGROUP"))) {
        throw error;
      }
    }
    this.running = true;
    this.logger.info("Dispute raised stream listener started", {
      streamKey: this.streamKey,
      consumerGroup: this.consumerGroup,
    });
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    try {
      if (this.pendingRead) await this.consumePending();
      await this.consumeNew();
    } catch (error) {
      this.logger.error("Dispute raised stream poll failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.running) {
        this.pollTimer = setTimeout(() => void this.poll(), this.pollIntervalMs);
      }
    }
  }

  private async consumePending(): Promise<void> {
    const result = await this.redis.xreadgroup(
      "GROUP",
      this.consumerGroup,
      this.consumerName,
      "COUNT",
      "50",
      "STREAMS",
      this.streamKey,
      "0",
    ) as Array<[string, Array<[string, string[]]>]> | null;
    if (!result) return;
    for (const [_stream, messages] of result) {
      for (const [messageId, fields] of messages) {
        await this.processMessage(messageId, fields);
      }
    }
  }

  private async consumeNew(): Promise<void> {
    const result = await this.redis.xreadgroup(
      "GROUP",
      this.consumerGroup,
      this.consumerName,
      "COUNT",
      "50",
      "BLOCK",
      String(this.blockMs),
      "STREAMS",
      this.streamKey,
      ">",
    ) as Array<[string, Array<[string, string[]]>]> | null;
    if (!result) return;
    for (const [_stream, messages] of result) {
      for (const [messageId, fields] of messages) {
        await this.processMessage(messageId, fields);
      }
    }
  }

  private async processMessage(messageId: string, fields: string[]): Promise<void> {
    const record = streamFieldsToRecord(fields);
    if (!isDisputeRaisedStreamTopic(record.topic)) {
      await this.redis.xack(this.streamKey, this.consumerGroup, messageId);
      return;
    }

    const payload = disputeRaisedPayloadFromStreamFields(fields);
    if (!payload) {
      this.logger.warn("Skipping malformed dispute raised stream event", { messageId });
      await this.redis.xack(this.streamKey, this.consumerGroup, messageId);
      return;
    }

    try {
      await this.handler.handle(payload);
      await this.redis.xack(this.streamKey, this.consumerGroup, messageId);
    } catch (error) {
      this.logger.error("Failed to process dispute raised stream event", {
        messageId,
        disputeId: payload.disputeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function handleDisputeRaised(
  payload: DisputeRaisedPayload,
  deps: DisputeRaisedHandlerDeps,
): Promise<DisputeRaisedHandlerResult> {
  return new DisputeRaisedEventHandler(deps).handle(payload);
}

export interface CreateDisputeRaisedHandlerOptions {
  db?: TransactionalDb;
  arbiterQueue?: ArbiterNotificationQueue;
  settlementTimerFreezer?: SettlementTimerFreezer;
  evidenceUrlResolver?: EvidenceUrlResolver;
  logger?: Logger;
  redisUrl?: string;
}

export function createDisputeRaisedHandler(
  options: CreateDisputeRaisedHandlerOptions = {},
): {
  handler: DisputeRaisedEventHandler;
  close: () => Promise<void>;
} {
  const ownsQueue = !options.arbiterQueue;
  const ownsFreezer = !options.settlementTimerFreezer;
  const redisUrl = options.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6379";
  const connection = redisConnectionFromUrl(redisUrl);
  const createdPool = options.db
    ? null
    : new Pool({
        connectionString:
          process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego",
        max: 4,
      });

  const arbiterQueue =
    options.arbiterQueue ?? new BullMQArbiterNotificationQueue(connection);
  const settlementTimerFreezer =
    options.settlementTimerFreezer ?? new BullMQSettlementTimerFreezer(connection);

  return {
    handler: new DisputeRaisedEventHandler({
      db: options.db ?? createdPool!,
      arbiterQueue,
      settlementTimerFreezer,
      evidenceUrlResolver: options.evidenceUrlResolver,
      logger: options.logger,
    }),
    close: async () => {
      const closers: Promise<void>[] = [];
      if (ownsQueue && "close" in arbiterQueue) {
        closers.push((arbiterQueue as BullMQArbiterNotificationQueue).close());
      }
      if (ownsFreezer && "close" in settlementTimerFreezer) {
        closers.push((settlementTimerFreezer as BullMQSettlementTimerFreezer).close());
      }
      if (createdPool) closers.push(createdPool.end());
      await Promise.all(closers);
    },
  };
}

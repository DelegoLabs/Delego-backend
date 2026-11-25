/**
 * Merkle tree audit log batch publisher to Stellar memos (Issue #613).
 *
 * Periodically takes the next un-anchored batch of `audit_log` entries
 * (default 1,000, ordered by `sequence_num`), computes their Merkle root via
 * `@delegolabs/utils`'s `buildMerkleTree`, and anchors that root on the
 * Stellar ledger as a 32-byte hash memo on a zero-value transaction — an
 * undeniable, externally-verifiable timestamp for that batch of audit
 * entries. The batch's leaf hashes are persisted in `merkle_batch_anchors`
 * (see `database/migrations/20261120_merkle_batch_anchors.sql`) so an
 * inclusion proof can be produced for any individual entry in the batch
 * later, without re-reading `audit_log` itself.
 *
 * Follows this app's existing worker convention (see `dlqManager.ts`,
 * `ipfsPinningWorker.ts`): the core `AuditAnchorWorker` class depends only
 * on structural interfaces (`AuditLogSource`, `AnchorStore`,
 * `StellarAnchorSubmitter`), so it can be unit-tested with fakes. Concrete
 * Postgres- and Stellar-SDK-backed implementations are provided below for
 * production wiring.
 */
import { randomUUID } from "node:crypto";
import {
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  Horizon,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { createLogger, buildMerkleTree, generateMerkleProof, type MerkleProofStep } from "@delegolabs/utils";

const log = createLogger("backend:audit-anchor-worker", process.env.LOG_LEVEL ?? "info");

/** Default batch size — "batches of 1,000 audit log hashes" per Issue #613. */
export const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_HORIZON_URL = "https://horizon.testnet.stellar.org";

export interface AuditEntryForAnchoring {
  sequenceNum: number;
  entryHash: string;
}

/** Structural source of audit_log entries — a `pg.Pool`-backed implementation is provided below. */
export interface AuditLogSource {
  /**
   * Fetch up to `limit` audit_log entries strictly after `afterSequenceNum`
   * (or from the start of the log when null), ordered by `sequence_num`
   * ascending.
   */
  getEntriesAfter(afterSequenceNum: number | null, limit: number): Promise<AuditEntryForAnchoring[]>;
}

export interface MerkleBatchAnchor {
  batchId: string;
  merkleRootHex: string;
  leafCount: number;
  startSequence: bigint;
  endSequence: bigint;
  stellarTxHash?: string;
  anchoredLedger?: number;
}

/** Structural anchor store — a `pg.Pool`-backed implementation is provided below. */
export interface AnchorStore {
  /** The `end_sequence` of the most recently anchored batch, or null if none exist yet. */
  getLastAnchoredSequence(): Promise<bigint | null>;
  saveAnchor(anchor: MerkleBatchAnchor, orderedLeafHashes: string[]): Promise<void>;
  getBatchLeafHashes(batchId: string): Promise<string[] | null>;
}

export interface StellarAnchorSubmitResult {
  txHash: string;
  ledger: number;
}

/** Structural Stellar submitter — a Horizon-backed implementation is provided below. */
export interface StellarAnchorSubmitter {
  /** Submit a zero-value transaction carrying `rootHashHex` as a 32-byte hash memo. */
  submitHashMemo(rootHashHex: string): Promise<StellarAnchorSubmitResult>;
}

export interface AuditProofResult {
  leafHash: string;
  proof: MerkleProofStep[];
  root: string;
  stellarTxHash?: string;
}

export class AuditAnchorWorker {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly source: AuditLogSource,
    private readonly anchors: AnchorStore,
    private readonly submitter: StellarAnchorSubmitter,
    private readonly batchSize: number = DEFAULT_BATCH_SIZE
  ) {}

  /**
   * Process the next batch, if a full batch (`batchSize` entries) is
   * available. Returns null when fewer than `batchSize` un-anchored
   * entries exist yet — a partial batch is deliberately left for the next
   * run rather than anchored early, so the batch boundaries stay aligned
   * to `batchSize` for every anchor except possibly the very last.
   */
  async runOnce(): Promise<MerkleBatchAnchor | null> {
    const lastAnchored = await this.anchors.getLastAnchoredSequence();
    const afterSequenceNum = lastAnchored === null ? null : Number(lastAnchored);

    const entries = await this.source.getEntriesAfter(afterSequenceNum, this.batchSize);
    if (entries.length < this.batchSize) {
      log.info("Not enough un-anchored audit entries for a full batch yet", {
        available: entries.length,
        batchSize: this.batchSize,
      });
      return null;
    }

    const leafHashes = entries.map((e) => e.entryHash);
    const tree = buildMerkleTree(leafHashes);
    const batchId = randomUUID();

    let submitResult: StellarAnchorSubmitResult | undefined;
    try {
      submitResult = await this.submitter.submitHashMemo(tree.root);
    } catch (err) {
      log.error("Failed to anchor Merkle root to Stellar", {
        error: (err as Error).message,
        root: tree.root,
        batchId,
      });
      throw err;
    }

    const anchor: MerkleBatchAnchor = {
      batchId,
      merkleRootHex: tree.root,
      leafCount: entries.length,
      startSequence: BigInt(entries[0].sequenceNum),
      endSequence: BigInt(entries[entries.length - 1].sequenceNum),
      stellarTxHash: submitResult.txHash,
      anchoredLedger: submitResult.ledger,
    };

    await this.anchors.saveAnchor(anchor, leafHashes);

    log.info("Audit log batch anchored to Stellar", {
      batchId,
      root: tree.root,
      leafCount: entries.length,
      startSequence: anchor.startSequence.toString(),
      endSequence: anchor.endSequence.toString(),
      stellarTxHash: submitResult.txHash,
    });

    return anchor;
  }

  /**
   * Generate an inclusion proof for one entry's `entryHash` within a
   * previously anchored batch, so it can be independently verified against
   * the root anchored on Stellar (Issue #613's "Merkle proofs can be
   * generated for any individual audit log entry").
   */
  async generateProof(batchId: string, entryHash: string): Promise<AuditProofResult | null> {
    const leafHashes = await this.anchors.getBatchLeafHashes(batchId);
    if (!leafHashes) return null;

    const leafIndex = leafHashes.indexOf(entryHash);
    if (leafIndex === -1) return null;

    const tree = buildMerkleTree(leafHashes);
    const proof = generateMerkleProof(tree, leafIndex);

    return { leafHash: entryHash, proof, root: tree.root };
  }

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.timer !== null) {
      log.warn("AuditAnchorWorker already running");
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) =>
        log.error("Audit anchor run failed", { error: (err as Error).message })
      );
    }, intervalMs);
    log.info("AuditAnchorWorker started", { intervalMs, batchSize: this.batchSize });
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      log.info("AuditAnchorWorker stopped");
    }
  }
}

// ---------------------------------------------------------------------------
// Concrete Postgres-backed AuditLogSource / AnchorStore
// ---------------------------------------------------------------------------

/** Minimal pg-compatible interface — matches `pg.Pool`/`pg.PoolClient`/`pg.Client`. */
export interface PgQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: T[] }>;
}

export class PostgresAuditLogSource implements AuditLogSource {
  constructor(private readonly db: PgQueryable) {}

  async getEntriesAfter(afterSequenceNum: number | null, limit: number): Promise<AuditEntryForAnchoring[]> {
    const result =
      afterSequenceNum === null
        ? await this.db.query<{ sequence_num: string | number; entry_hash: string }>(
            `SELECT sequence_num, entry_hash FROM audit_log ORDER BY sequence_num ASC LIMIT $1`,
            [limit]
          )
        : await this.db.query<{ sequence_num: string | number; entry_hash: string }>(
            `SELECT sequence_num, entry_hash FROM audit_log WHERE sequence_num > $1 ORDER BY sequence_num ASC LIMIT $2`,
            [afterSequenceNum, limit]
          );

    return result.rows.map((row) => ({
      sequenceNum: Number(row.sequence_num),
      entryHash: row.entry_hash,
    }));
  }
}

export class PostgresAnchorStore implements AnchorStore {
  constructor(private readonly db: PgQueryable) {}

  async getLastAnchoredSequence(): Promise<bigint | null> {
    const result = await this.db.query<{ end_sequence: string | number }>(
      `SELECT end_sequence FROM merkle_batch_anchors ORDER BY end_sequence DESC LIMIT 1`
    );
    const row = result.rows[0];
    return row ? BigInt(row.end_sequence) : null;
  }

  async saveAnchor(anchor: MerkleBatchAnchor, orderedLeafHashes: string[]): Promise<void> {
    await this.db.query(
      `INSERT INTO merkle_batch_anchors (
         batch_id, merkle_root_hex, leaf_count, start_sequence, end_sequence,
         leaf_hashes, stellar_tx_hash, anchored_ledger, published_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        anchor.batchId,
        anchor.merkleRootHex,
        anchor.leafCount,
        anchor.startSequence.toString(),
        anchor.endSequence.toString(),
        JSON.stringify(orderedLeafHashes),
        anchor.stellarTxHash ?? null,
        anchor.anchoredLedger ?? null,
      ]
    );
  }

  async getBatchLeafHashes(batchId: string): Promise<string[] | null> {
    const result = await this.db.query<{ leaf_hashes: string[] }>(
      `SELECT leaf_hashes FROM merkle_batch_anchors WHERE batch_id = $1`,
      [batchId]
    );
    return result.rows[0]?.leaf_hashes ?? null;
  }
}

// ---------------------------------------------------------------------------
// Concrete Stellar submitter
// ---------------------------------------------------------------------------

export interface StellarAnchorConfig {
  stellarSecretKey: string;
  stellarPublicKey: string;
  horizonUrl?: string;
}

/** Submits the Merkle root as a 32-byte `Memo.hash` on a zero-value payment transaction. */
export class StellarHashMemoSubmitter implements StellarAnchorSubmitter {
  private readonly horizon: Horizon.Server;
  private readonly keypair: Keypair;
  private readonly destination: string;

  constructor(config: StellarAnchorConfig) {
    this.horizon = new Horizon.Server(config.horizonUrl ?? DEFAULT_HORIZON_URL);
    this.keypair = Keypair.fromSecret(config.stellarSecretKey);
    this.destination = config.stellarPublicKey;
  }

  async submitHashMemo(rootHashHex: string): Promise<StellarAnchorSubmitResult> {
    const rootBytes = Buffer.from(rootHashHex, "hex");
    if (rootBytes.length !== 32) {
      throw new Error(
        `StellarHashMemoSubmitter: expected a 32-byte (64 hex char) Merkle root, got ${rootBytes.length} bytes`
      );
    }

    const accountId = this.keypair.publicKey();
    const account = await this.horizon.loadAccount(accountId);

    const transaction = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: this.destination,
          asset: Asset.native(),
          amount: "0.0000001",
        })
      )
      .addMemo(Memo.hash(rootBytes))
      .setTimeout(30)
      .build();

    transaction.sign(this.keypair);

    const response = await this.horizon.submitTransaction(transaction);
    return { txHash: response.hash, ledger: response.ledger };
  }
}

/** Create an `AuditAnchorWorker` wired to Postgres and Stellar from environment variables. */
export function createAuditAnchorWorkerFromEnv(db: PgQueryable): AuditAnchorWorker {
  const batchSize = Number.parseInt(
    process.env.AUDIT_ANCHOR_BATCH_SIZE ?? String(DEFAULT_BATCH_SIZE),
    10
  );

  const submitter = new StellarHashMemoSubmitter({
    stellarSecretKey: process.env.STELLAR_AUDIT_SECRET_KEY ?? "",
    stellarPublicKey: process.env.STELLAR_AUDIT_PUBLIC_KEY ?? "",
    horizonUrl: process.env.STELLAR_HORIZON_URL,
  });

  return new AuditAnchorWorker(
    new PostgresAuditLogSource(db),
    new PostgresAnchorStore(db),
    submitter,
    Number.isFinite(batchSize) && batchSize > 0 ? batchSize : DEFAULT_BATCH_SIZE
  );
}

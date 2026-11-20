/**
 * Soroban contract instance auto-restoration — Issue #608.
 *
 * When a contract (or contract data) entry expires from network dormancy it
 * enters Soroban's "archived" state and reads/writes against it fail until a
 * `restore_footprint` operation brings it back. This module is the
 * background worker side of that: a BullMQ queue accepts
 * {@link RestorationJobData} jobs (enqueued whenever wallet code hits an
 * "entry archived" failure while touching a dormant merchant escrow
 * contract), and {@link ContractRestorationService} builds, simulates,
 * signs and submits the `RestoreFootprintOp` envelope, then verifies the
 * contract is active again before reporting success.
 */

import { Queue, Worker, type Job } from "bullmq";
import {
  Address,
  Keypair,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { createLogger } from "@delegolabs/utils";
import { vaultService } from "../vault.js";
import { getStellarConfig } from "../assets/config.js";
import { getTransactionFee } from "../dynamicFee.js";
import { getRedisConnection } from "../queue/txQueue.js";

const log = createLogger("wallet:stellar:restoration", process.env.LOG_LEVEL ?? "info");

export interface RestorationJobData {
  contractAddress: string;
  /** Base64-encoded XDR `LedgerKey` entries to restore (the archived read-write footprint). */
  keysToRestore: string[];
  priority: "high" | "normal";
}

export interface RestorationResult {
  contractAddress: string;
  /** True when a restore_footprint transaction was submitted and confirmed. */
  restored: boolean;
  txHash?: string;
  /** Whether the contract instance is active (not archived) after the attempt. */
  active: boolean;
  /** True when restoration was skipped because the contract was already active. */
  skipped?: boolean;
  error?: string;
}

export interface ContractRestorationServiceDeps {
  rpcUrl?: string;
  networkPassphrase?: string;
  fundingAddress?: string;
  getSecret?: (publicKey: string) => Promise<string>;
  rpcServer?: rpc.Server;
}

const RESTORATION_QUEUE_NAME = "soroban-restoration";

/** BullMQ priority: lower number = processed first. "high" jumps the queue ahead of routine restorations. */
const JOB_PRIORITY: Record<RestorationJobData["priority"], number> = {
  high: 1,
  normal: 10,
};

function decodeLedgerKeys(keysToRestore: string[]): xdr.LedgerKey[] {
  if (!keysToRestore || keysToRestore.length === 0) {
    throw new Error("keysToRestore must contain at least one base64-encoded LedgerKey to restore");
  }
  return keysToRestore.map((key, index) => {
    try {
      return xdr.LedgerKey.fromXDR(key, "base64");
    } catch (err) {
      throw new Error(
        `Invalid ledger key at keysToRestore[${index}] (expected base64-encoded LedgerKey XDR): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
}

/**
 * LedgerKey for a contract's *instance* entry (executable + storage),
 * independent of whatever data keys `keysToRestore` lists. This is what we
 * re-check after restoration to confirm the contract itself is reachable
 * again — `keysToRestore` may only cover contract-data entries, not the
 * instance.
 */
function contractInstanceLedgerKey(contractAddress: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractAddress).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

export class ContractRestorationService {
  private readonly rpcServer: rpc.Server;
  private readonly fundingAddress: string;
  private readonly networkPassphrase: string;
  private readonly horizonUrl: string;
  private readonly getSecret: (publicKey: string) => Promise<string>;

  constructor(deps: ContractRestorationServiceDeps = {}) {
    const config = getStellarConfig();
    this.rpcServer = deps.rpcServer ?? new rpc.Server(deps.rpcUrl ?? config.rpcUrl);
    this.networkPassphrase = deps.networkPassphrase ?? config.networkPassphrase;
    this.horizonUrl = config.horizonUrl;
    this.fundingAddress = deps.fundingAddress ?? process.env.SOROBAN_RESTORATION_FUNDER_ADDRESS ?? "";
    this.getSecret = deps.getSecret ?? ((publicKey: string) => vaultService.getKey(publicKey));
  }

  /**
   * Restores an archived contract instance/data footprint. No-op (returns
   * `skipped: true`) when the contract is already active, so callers can
   * invoke this unconditionally from a "footprint expired" error handler
   * without racing a restoration that another worker already completed.
   */
  async restore(job: RestorationJobData): Promise<RestorationResult> {
    if (!this.fundingAddress) {
      throw new Error(
        "No restoration funding address configured (set SOROBAN_RESTORATION_FUNDER_ADDRESS or pass fundingAddress)",
      );
    }

    const alreadyActive = await this.isContractActive(job.contractAddress);
    if (alreadyActive) {
      log.info("Contract already active; skipping restoration", { contractAddress: job.contractAddress });
      return { contractAddress: job.contractAddress, restored: false, active: true, skipped: true };
    }

    const ledgerKeys = decodeLedgerKeys(job.keysToRestore);
    const secret = await this.getSecret(this.fundingAddress);
    const signer = Keypair.fromSecret(secret);
    const account = await this.rpcServer.getAccount(this.fundingAddress);

    const sorobanData = new SorobanDataBuilder().setReadWrite(ledgerKeys).build();

    let fee: string;
    try {
      fee = await getTransactionFee(this.horizonUrl);
    } catch {
      fee = "100000";
    }

    let tx = new TransactionBuilder(account, {
      fee,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(Operation.restoreFootprint({}))
      .setSorobanData(sorobanData)
      .setTimeout(30)
      .build();

    const simRes = await this.rpcServer.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(simRes)) {
      const message = rpc.Api.isSimulationError(simRes)
        ? simRes.error
        : "restore_footprint simulation returned an unexpected response";
      throw new Error(`Restore footprint simulation failed for ${job.contractAddress}: ${message}`);
    }

    tx = rpc.assembleTransaction(tx, simRes).build();
    tx.sign(signer);
    const txHash = tx.hash().toString("hex");

    log.info("Submitting restore_footprint transaction", {
      contractAddress: job.contractAddress,
      txHash,
      keysToRestore: job.keysToRestore.length,
      priority: job.priority,
    });

    const sendRes = await this.rpcServer.sendTransaction(tx);
    if (sendRes.status === "ERROR") {
      throw new Error(`Restore footprint submission rejected: ${JSON.stringify(sendRes)}`);
    }

    const confirmed = await this.pollForConfirmation(sendRes.hash ?? txHash);
    const active = await this.isContractActive(job.contractAddress);

    if (!confirmed) {
      log.warn("Restore footprint transaction did not confirm within the poll window", {
        contractAddress: job.contractAddress,
        txHash,
      });
      return {
        contractAddress: job.contractAddress,
        restored: false,
        txHash,
        active,
        error: "Restoration transaction did not confirm in time",
      };
    }

    log[active ? "info" : "warn"]("Restore footprint transaction confirmed", {
      contractAddress: job.contractAddress,
      txHash,
      active,
    });

    return { contractAddress: job.contractAddress, restored: true, txHash, active };
  }

  /** Checks whether the contract instance entry still exists and has not passed its TTL ledger. */
  async isContractActive(contractAddress: string): Promise<boolean> {
    try {
      const key = contractInstanceLedgerKey(contractAddress);
      const response = await this.rpcServer.getLedgerEntries(key);
      if (!response.entries || response.entries.length === 0) {
        return false;
      }
      const entry = response.entries[0] as { liveUntilLedgerSeq?: number };
      if (typeof entry.liveUntilLedgerSeq !== "number") {
        // No TTL on the entry (shouldn't happen for a contract instance, but
        // fail open rather than treat a present entry as archived).
        return true;
      }
      const latestLedger = response.latestLedger ?? entry.liveUntilLedgerSeq;
      return entry.liveUntilLedgerSeq >= latestLedger;
    } catch (err) {
      log.warn("Failed to check contract active state; assuming archived", {
        contractAddress,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async pollForConfirmation(txHash: string): Promise<boolean> {
    const maxAttempts = process.env.NODE_ENV === "test" ? 2 : 12; // ~1 minute in production
    const delayMs = process.env.NODE_ENV === "test" ? 10 : 5000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const status = await this.rpcServer.getTransaction(txHash);
        if (status.status === rpc.Api.GetTransactionStatus.SUCCESS) return true;
        if (status.status === rpc.Api.GetTransactionStatus.FAILED) return false;
        // NOT_FOUND — keep polling, the ledger may not have closed yet.
      } catch (err) {
        log.warn("Restoration status poll failed; retrying", {
          txHash,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return false;
  }
}

let restorationQueue: Queue<RestorationJobData> | null = null;
let restorationWorker: Worker<RestorationJobData> | null = null;

/**
 * Lazily creates the restoration queue/worker pair. Returns `null` handles
 * in `NODE_ENV=test` (mirroring `initQueue()` in `queue/txQueue.ts`) so unit
 * tests exercise {@link ContractRestorationService} directly instead of
 * standing up a real Redis-backed worker.
 */
export function initRestorationQueue(
  service: ContractRestorationService = new ContractRestorationService(),
): { restorationQueue: Queue<RestorationJobData> | null; restorationWorker: Worker<RestorationJobData> | null } {
  if (process.env.NODE_ENV === "test") {
    return { restorationQueue: null, restorationWorker: null };
  }
  if (restorationQueue) {
    return { restorationQueue, restorationWorker };
  }

  const connection = getRedisConnection();

  restorationQueue = new Queue(RESTORATION_QUEUE_NAME, {
    connection: connection as any,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  });

  restorationWorker = new Worker(
    RESTORATION_QUEUE_NAME,
    async (job: Job<RestorationJobData>) => service.restore(job.data),
    {
      connection: connection as any,
      // Restorations touch different contracts independently; a handful can
      // run concurrently without the strict-ordering constraint `txQueue`
      // needs for sequence numbers.
      concurrency: 2,
    },
  );

  restorationWorker.on("failed", (job, err) => {
    log.error("Contract restoration job failed", {
      contractAddress: job?.data.contractAddress,
      attempt: job?.attemptsMade,
      error: err.message,
    });
  });

  return { restorationQueue, restorationWorker };
}

/**
 * Enqueues a restoration job. Falls back to running inline when no queue is
 * available (e.g. `NODE_ENV=test`), so callers get the same observable
 * behavior either way.
 */
export async function enqueueRestorationJob(
  data: RestorationJobData,
  service: ContractRestorationService = new ContractRestorationService(),
): Promise<RestorationResult | void> {
  const { restorationQueue: queue } = initRestorationQueue(service);
  if (!queue) {
    return service.restore(data);
  }
  await queue.add("restore", data, {
    priority: JOB_PRIORITY[data.priority],
    jobId: `restore:${data.contractAddress}`,
  });
}

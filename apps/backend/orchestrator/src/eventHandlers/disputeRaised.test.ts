import { describe, expect, it, vi } from "vitest";
import type { QueryResultRow } from "pg";
import {
  ARBITER_NOTIFICATION_JOB,
  ARBITER_NOTIFICATION_QUEUE,
  DisputeRaisedValidationError,
  buildDisputeEvidenceUrl,
  disputeRaisedPayloadFromStreamFields,
  handleDisputeRaised,
  type ArbiterNotificationJobData,
  type DisputeRaisedPayload,
  type QueryResultLike,
  type Queryable,
} from "./disputeRaised.js";

const payload: DisputeRaisedPayload = {
  orderId: "order-1",
  disputeId: "dispute-1",
  initiatorAddress: "GBUYER",
  disputeReasonCode: 3,
  evidenceHash: "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
  ledgerSequence: 42,
};

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

class FakeDb implements Queryable {
  readonly calls: Array<{ text: string; values?: unknown[] }> = [];

  constructor(
    private readonly order: Record<string, unknown> | null = {
      id: "order-1",
      user_id: "user-1",
      merchant_id: "merchant-1",
      escrow_contract_id: "contract-1",
      status: "paid",
    },
    private readonly evidenceFiles: unknown[] = [],
  ) {}

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResultLike<T>> {
    this.calls.push({ text, values });

    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) {
      return { rows: [], rowCount: 0 };
    }
    if (/FROM orders/.test(text)) {
      return {
        rows: (this.order ? [this.order] : []) as T[],
        rowCount: this.order ? 1 : 0,
      };
    }
    if (/FROM payment_records/.test(text)) {
      return { rows: [{ escrow_id: "escrow-1" }] as T[], rowCount: 1 };
    }
    if (/UPDATE orders/.test(text)) {
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE payment_records/.test(text)) {
      return { rows: [], rowCount: 1 };
    }
    if (/FROM dispute_evidence/.test(text)) {
      return {
        rows: this.evidenceFiles.map((files) => ({ files })) as T[],
        rowCount: this.evidenceFiles.length,
      };
    }
    return { rows: [], rowCount: 0 };
  }
}

function createDeps(db: FakeDb) {
  const arbiterQueue = {
    add: vi.fn().mockResolvedValue({ id: "arbiter-job-1" }),
  };
  const settlementTimerFreezer = {
    freeze: vi.fn().mockResolvedValue({
      queueNames: ["escrow-auto-release", "escrow-auto-release-trigger"],
      removedJobIds: ["release-job-1"],
    }),
  };
  return {
    db,
    arbiterQueue,
    settlementTimerFreezer,
    logger: silentLogger,
  };
}

describe("handleDisputeRaised", () => {
  it("marks the order disputed, freezes settlement timers, and queues an arbiter notification with an evidence URL", async () => {
    const db = new FakeDb(undefined, [["ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"]]);
    const deps = createDeps(db);

    const result = await handleDisputeRaised(payload, deps);

    const orderUpdate = db.calls.find(({ text }) => /UPDATE orders/.test(text));
    expect(orderUpdate?.values).toEqual([
      "order-1",
      payload.evidenceHash,
      "dispute-1",
      3,
      42,
    ]);
    expect(orderUpdate?.text).toContain("status = 'disputed'");
    expect(orderUpdate?.text).toContain("evidence_hash = $2");

    const paymentUpdate = db.calls.find(({ text }) => /UPDATE payment_records/.test(text));
    expect(paymentUpdate?.text).toContain("status = 'disputed'");
    expect(paymentUpdate?.text).toContain("'released', 'refunded', 'failed'");

    expect(deps.settlementTimerFreezer.freeze).toHaveBeenCalledWith({
      orderId: "order-1",
      disputeId: "dispute-1",
      escrowId: "escrow-1",
    });

    expect(deps.arbiterQueue.add).toHaveBeenCalledWith(
      ARBITER_NOTIFICATION_JOB,
      expect.objectContaining({
        event: "dispute.raised",
        audience: "arbiters",
        orderId: "order-1",
        disputeId: "dispute-1",
        evidenceHash: payload.evidenceHash,
        evidenceUrl: "https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
        ledgerSequence: 42,
      } satisfies Partial<ArbiterNotificationJobData>),
      expect.objectContaining({
        jobId: "dispute-raised:dispute-1",
      }),
    );
    expect(result.orderStatus).toBe("disputed");
    expect(result.evidenceUrl).toContain("https://ipfs.io/ipfs/");
    expect(result.arbiterNotificationJobId).toBe("arbiter-job-1");
  });

  it("uses a stored dispute evidence file URL when one matches the evidence hash", async () => {
    const db = new FakeDb(undefined, [["https://cdn.example.com/dispute-evidence/proof.pdf"]]);
    const deps = createDeps(db);
    const opaquePayload = { ...payload, evidenceHash: "deadbeef" };

    const result = await handleDisputeRaised(opaquePayload, deps);

    expect(result.evidenceUrl).toBe("https://cdn.example.com/dispute-evidence/proof.pdf");
    expect(deps.arbiterQueue.add).toHaveBeenCalledWith(
      ARBITER_NOTIFICATION_JOB,
      expect.objectContaining({ evidenceUrl: "https://cdn.example.com/dispute-evidence/proof.pdf" }),
      expect.anything(),
    );
  });

  it("rejects invalid payloads before touching the database", async () => {
    const db = new FakeDb();
    const deps = createDeps(db);

    await expect(
      handleDisputeRaised({ ...payload, evidenceHash: "  " }, deps),
    ).rejects.toBeInstanceOf(DisputeRaisedValidationError);
    expect(db.calls).toHaveLength(0);
    expect(deps.arbiterQueue.add).not.toHaveBeenCalled();
  });

  it("throws when the order does not exist", async () => {
    const db = new FakeDb(null);
    const deps = createDeps(db);

    await expect(handleDisputeRaised(payload, deps)).rejects.toThrow(
      "Order not found for dispute event: order-1",
    );
    expect(deps.arbiterQueue.add).not.toHaveBeenCalled();
    expect(deps.settlementTimerFreezer.freeze).not.toHaveBeenCalled();
  });
});

describe("buildDisputeEvidenceUrl", () => {
  it("passes through absolute evidence URLs", () => {
    const url = buildDisputeEvidenceUrl(
      { orderId: "o", disputeId: "d", evidenceHash: "https://files.example.com/evidence.pdf" },
      {},
    );
    expect(url).toBe("https://files.example.com/evidence.pdf");
  });

  it("resolves IPFS CIDs through the configured gateway", () => {
    const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    const url = buildDisputeEvidenceUrl(
      { orderId: "o", disputeId: "d", evidenceHash: cid },
      { IPFS_GATEWAY_URL: "https://gateway.example.com/" },
    );
    expect(url).toBe(`https://gateway.example.com/ipfs/${cid}`);
  });

  it("builds an object URL for storage-backed evidence keys", () => {
    const url = buildDisputeEvidenceUrl(
      {
        orderId: "o",
        disputeId: "d",
        evidenceHash: "dispute_evidence/123/proof.pdf",
      },
      {
        STORAGE_BUCKET_NAME: "delego-uploads",
        STORAGE_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      },
    );
    expect(url).toBe(
      "https://account.r2.cloudflarestorage.com/delego-uploads/dispute_evidence/123/proof.pdf",
    );
  });
});

describe("disputeRaisedPayloadFromStreamFields", () => {
  it("maps a normalized Soroban stream message to the handler payload", () => {
    const parsed = disputeRaisedPayloadFromStreamFields([
      "eventId",
      "evt-1",
      "contractId",
      "contract-1",
      "topic",
      "DisputeRaised",
      "data",
      JSON.stringify({
        orderId: "order-1",
        disputeId: "dispute-1",
        initiatorAddress: "GBUYER",
        disputeReasonCode: 3,
        evidenceHash: "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      }),
      "ledger",
      "42",
      "txHash",
      "tx-1",
      "timestamp",
      "2026-01-01T00:00:00.000Z",
    ]);

    expect(parsed).toEqual(payload);
  });

  it("ignores non-dispute stream topics", () => {
    expect(
      disputeRaisedPayloadFromStreamFields([
        "topic",
        "EscrowReleased",
        "data",
        JSON.stringify({ orderId: "order-1" }),
        "ledger",
        "42",
      ]),
    ).toBeNull();
  });
});

describe("arbiter notification contract", () => {
  it("uses the dedicated arbiter queue name", () => {
    expect(ARBITER_NOTIFICATION_QUEUE).toBe("arbiter-notifications");
  });
});

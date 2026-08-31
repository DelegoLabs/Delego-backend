/**
 * XDR Payload Size Guard — unit tests
 *
 * Tests validateXdrSize and the guard inside addTransactionToQueue.
 * All external I/O (BullMQ, Redis, Vault, Stellar SDK) is mocked so the
 * suite runs without any real infrastructure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TransactionRequest } from "@delegolabs/types";

// ---------------------------------------------------------------------------
// Mock all heavy external modules before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue({ id: "job-1" }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  Worker: vi.fn().mockImplementation(() => ({
    close: vi.fn().mockResolvedValue(undefined),
  })),
  QueueEvents: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "UnrecoverableError";
    }
  },
}));

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(() => ({
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(0),
    lrange: vi.fn().mockResolvedValue([]),
    rpush: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    lrem: vi.fn().mockResolvedValue(0),
    keys: vi.fn().mockResolvedValue([]),
    quit: vi.fn().mockResolvedValue("OK"),
    on: vi.fn(),
  })),
}));

vi.mock("ioredis-mock", () => ({
  default: vi.fn().mockImplementation(() => ({
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(0),
    lrange: vi.fn().mockResolvedValue([]),
    rpush: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    lrem: vi.fn().mockResolvedValue(0),
    keys: vi.fn().mockResolvedValue([]),
    quit: vi.fn().mockResolvedValue("OK"),
    on: vi.fn(),
  })),
}));

vi.mock("../vault.js", () => ({
  vaultService: {
    getKey: vi.fn().mockResolvedValue("SCZANGBA5AKIA5TO6IPJG7P5VGQZGG5P4GKDPKYI77RCZRNB3AVFBEJ"),
  },
}));

vi.mock("@stellar/stellar-sdk", () => ({
  Keypair: { fromSecret: vi.fn().mockReturnValue({ publicKey: vi.fn().mockReturnValue("G...") }) },
  Horizon: {
    Server: vi.fn().mockImplementation(() => ({
      loadAccount: vi.fn().mockResolvedValue({ sequenceNumber: () => "1000" }),
      transactions: vi.fn().mockReturnValue({
        transaction: vi.fn().mockReturnValue({ call: vi.fn().mockResolvedValue({}) }),
      }),
    })),
  },
  rpc: {
    Server: vi.fn().mockImplementation(() => ({
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
    })),
    Api: {
      isSimulationSuccess: vi.fn().mockReturnValue(true),
      GetTransactionStatus: { SUCCESS: "SUCCESS", FAILED: "FAILED" },
    },
    assembleTransaction: vi.fn().mockReturnValue({
      build: vi.fn().mockReturnValue({ sign: vi.fn(), hash: vi.fn().mockReturnValue(Buffer.from("abc", "hex")) }),
    }),
  },
  TransactionBuilder: vi.fn().mockImplementation(() => ({
    addOperation: vi.fn().mockReturnThis(),
    setTimeout: vi.fn().mockReturnThis(),
    build: vi.fn().mockReturnValue({
      sign: vi.fn(),
      hash: vi.fn().mockReturnValue(Buffer.from("abc", "hex")),
    }),
  })),
  Networks: { TESTNET: "Test SDF Network ; September 2015", PUBLIC: "Public Global Stellar Network ; September 2015", FUTURENET: "Test SDF Future Network ; October 2022" },
  Operation: { invokeContractFunction: vi.fn().mockReturnValue({}) },
  nativeToScVal: vi.fn().mockReturnValue({}),
  Address: { fromString: vi.fn().mockReturnValue({ toScVal: vi.fn().mockReturnValue({}) }) },
  Account: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("./submissionFailure.js", () => ({
  classifySubmissionFailure: vi.fn().mockReturnValue({ code: "UNKNOWN", message: "error", retryable: false }),
  SubmissionFailure: {},
}));

vi.mock("./sequenceMonitoring.js", () => ({
  recordAuditEntry: vi.fn().mockResolvedValue(undefined),
  recordLockAcquisition: vi.fn().mockResolvedValue(undefined),
  recordLockRelease: vi.fn().mockResolvedValue(undefined),
  recordContentionEvent: vi.fn().mockResolvedValue(undefined),
  detectSequenceGap: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./transactionDLQ.js", () => ({
  addToDLQ: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../sorobanSimulator.js", () => ({
  SorobanTransactionSimulator: vi.fn().mockImplementation(() => ({
    simulateTransaction: vi.fn().mockResolvedValue({ minResourceFee: "100" }),
    detectFailureReasons: vi.fn().mockReturnValue([]),
    extractFeeEstimates: vi.fn().mockReturnValue({ cpu: 0, memory: 0 }),
  })),
  readSorobanRpcConfig: vi.fn().mockReturnValue({ rpcUrl: "https://mock", timeoutMs: 5000, maxRetries: 1 }),
}));

vi.mock("../dynamicFee.js", () => ({
  getTransactionFee: vi.fn().mockResolvedValue("100"),
}));

vi.mock("../spendLimits.js", () => ({
  checkSpendLimit: vi.fn().mockResolvedValue({ allowed: true }),
  recordSpend: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../models/Wallet.js", () => ({
  Wallet: {
    findOne: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../batchSubmitter.js", () => ({
  submitTransactionBatch: vi.fn(),
  estimateBatchGas: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Now import the module under test
// ---------------------------------------------------------------------------

import { validateXdrSize, addTransactionToQueue, type XdrValidationResult } from "./txQueue.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the smallest possible valid TransactionRequest. */
function makeRequest(overrides: Partial<TransactionRequest> = {}): TransactionRequest {
  return {
    sourceAddress: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZPZQ5GO2KWKWVBER5D7R",
    contractId: "CDIVITQCZ3WFCG2AMRLH5MSEZXVZ7I6CKXPG4SBRQ4PVHQSOFKWM2K",
    method: "transfer",
    args: ["addr1", "addr2", 100],
    memo: "test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: validateXdrSize
// ---------------------------------------------------------------------------

describe("validateXdrSize", () => {
  afterEach(() => {
    delete process.env.MAX_XDR_BYTES;
  });

  it("returns valid:true for a small payload", () => {
    const request = makeRequest();
    const result: XdrValidationResult = validateXdrSize(request);

    expect(result.valid).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.maxBytes).toBe(65536);
    expect(result.error).toBeUndefined();
  });

  it("returns valid:false with an error string when payload exceeds default limit", () => {
    // Build a payload whose serialized size is > 65536 bytes
    const bigArgs = Array.from({ length: 10000 }, (_, i) => `argument-value-${i}`);
    const request = makeRequest({ args: bigArgs });
    const result = validateXdrSize(request);

    expect(result.valid).toBe(false);
    expect(result.sizeBytes).toBeGreaterThan(65536);
    expect(result.maxBytes).toBe(65536);
    expect(result.error).toBe(
      `Payload too large: ${result.sizeBytes} bytes exceeds limit of ${result.maxBytes} bytes`
    );
  });

  it("respects a custom MAX_XDR_BYTES env var", () => {
    // Set a tiny limit so even a minimal payload is oversized
    process.env.MAX_XDR_BYTES = "10";

    const request = makeRequest();
    const result = validateXdrSize(request);

    expect(result.maxBytes).toBe(10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("exceeds limit of 10 bytes");
  });

  it("falls back to 65536 when MAX_XDR_BYTES is not a number ('abc')", () => {
    process.env.MAX_XDR_BYTES = "abc";

    const request = makeRequest();
    const result = validateXdrSize(request);

    expect(result.maxBytes).toBe(65536);
  });

  it("falls back to 65536 when MAX_XDR_BYTES is zero", () => {
    process.env.MAX_XDR_BYTES = "0";

    const request = makeRequest();
    const result = validateXdrSize(request);

    expect(result.maxBytes).toBe(65536);
  });

  it("falls back to 65536 when MAX_XDR_BYTES is negative", () => {
    process.env.MAX_XDR_BYTES = "-100";

    const request = makeRequest();
    const result = validateXdrSize(request);

    expect(result.maxBytes).toBe(65536);
  });

  it("reports sizeBytes equal to Buffer.byteLength of JSON.stringify(request)", () => {
    const request = makeRequest();
    const expected = Buffer.byteLength(JSON.stringify(request), "utf8");
    const result = validateXdrSize(request);

    expect(result.sizeBytes).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Tests: addTransactionToQueue size guard
// ---------------------------------------------------------------------------

describe("addTransactionToQueue — XDR size guard", () => {
  beforeEach(() => {
    delete process.env.MAX_XDR_BYTES;
    // Ensure test mode so we don't need a real BullMQ queue
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    delete process.env.MAX_XDR_BYTES;
  });

  it("throws when the payload exceeds the size limit", async () => {
    process.env.MAX_XDR_BYTES = "10"; // tiny limit

    const request = makeRequest();
    await expect(addTransactionToQueue(request)).rejects.toThrow(
      /Payload too large:/
    );
  });

  it("throws with the exact error message produced by validateXdrSize", async () => {
    process.env.MAX_XDR_BYTES = "10";

    const request = makeRequest();
    const expected = validateXdrSize(request).error as string;

    await expect(addTransactionToQueue(request)).rejects.toThrow(expected);
  });
});

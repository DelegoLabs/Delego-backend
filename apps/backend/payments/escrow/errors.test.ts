import { describe, it, expect } from "vitest";
import { ContractInvocationError, normalizeContractError } from "./errors.js";

// ---------------------------------------------------------------------------
// ContractInvocationError — class behaviour
// ---------------------------------------------------------------------------

describe("ContractInvocationError", () => {
  it("is an instance of Error", () => {
    const err = new ContractInvocationError("oops", "SOME_CODE", false);
    expect(err).toBeInstanceOf(Error);
  });

  it("is an instance of ContractInvocationError", () => {
    const err = new ContractInvocationError("oops", "SOME_CODE", false);
    expect(err).toBeInstanceOf(ContractInvocationError);
  });

  it("sets name to ContractInvocationError", () => {
    const err = new ContractInvocationError("oops", "SOME_CODE", false);
    expect(err.name).toBe("ContractInvocationError");
  });

  it("stores code", () => {
    const err = new ContractInvocationError("msg", "MY_CODE", true);
    expect(err.code).toBe("MY_CODE");
  });

  it("stores retryable flag (true)", () => {
    const err = new ContractInvocationError("msg", "X", true);
    expect(err.retryable).toBe(true);
  });

  it("stores retryable flag (false)", () => {
    const err = new ContractInvocationError("msg", "X", false);
    expect(err.retryable).toBe(false);
  });

  it("stores txHash when provided", () => {
    const err = new ContractInvocationError("msg", "X", false, "abc123");
    expect(err.txHash).toBe("abc123");
  });

  it("txHash is undefined when omitted", () => {
    const err = new ContractInvocationError("msg", "X", false);
    expect(err.txHash).toBeUndefined();
  });

  it("preserves the message", () => {
    const err = new ContractInvocationError("something went wrong", "X", false);
    expect(err.message).toBe("something went wrong");
  });
});

// ---------------------------------------------------------------------------
// normalizeContractError — pass-through
// ---------------------------------------------------------------------------

describe("normalizeContractError — pass-through", () => {
  it("returns a ContractInvocationError unchanged", () => {
    const original = new ContractInvocationError("already classified", "MY_CODE", true, "txABC");
    const result = normalizeContractError(original);
    expect(result).toBe(original);
  });

  it("does not alter fields when passed a ContractInvocationError", () => {
    const original = new ContractInvocationError("msg", "CODE", false, "hash");
    const result = normalizeContractError(original, "different-hash");
    expect(result.code).toBe("CODE");
    expect(result.txHash).toBe("hash");
  });
});

// ---------------------------------------------------------------------------
// normalizeContractError — simulation failed
// ---------------------------------------------------------------------------

describe("normalizeContractError — simulation failed", () => {
  it("classifies 'simulation failed' (lower-case) as CONTRACT_SIMULATION_FAILED", () => {
    const result = normalizeContractError(new Error("simulation failed: insufficient balance"));
    expect(result.code).toBe("CONTRACT_SIMULATION_FAILED");
    expect(result.retryable).toBe(false);
  });

  it("classifies 'Simulation Failed' (mixed-case) as CONTRACT_SIMULATION_FAILED", () => {
    const result = normalizeContractError(new Error("Simulation Failed"));
    expect(result.code).toBe("CONTRACT_SIMULATION_FAILED");
  });

  it("classifies 'SIMULATION FAILED' (upper-case) as CONTRACT_SIMULATION_FAILED", () => {
    const result = normalizeContractError(new Error("SIMULATION FAILED during invocation"));
    expect(result.code).toBe("CONTRACT_SIMULATION_FAILED");
  });

  it("attaches txHash when provided", () => {
    const result = normalizeContractError(new Error("simulation failed"), "txSim");
    expect(result.txHash).toBe("txSim");
  });

  it("preserves original message", () => {
    const result = normalizeContractError(new Error("simulation failed: bad param"));
    expect(result.message).toBe("simulation failed: bad param");
  });
});

// ---------------------------------------------------------------------------
// normalizeContractError — submission failed / bad seq
// ---------------------------------------------------------------------------

describe("normalizeContractError — submission failed / bad seq", () => {
  it("classifies 'Submission failed' as CONTRACT_SUBMISSION_FAILED, retryable", () => {
    const result = normalizeContractError(new Error("Submission failed: network error"));
    expect(result.code).toBe("CONTRACT_SUBMISSION_FAILED");
    expect(result.retryable).toBe(true);
  });

  it("classifies 'tx_bad_seq' as CONTRACT_SUBMISSION_FAILED, retryable", () => {
    const result = normalizeContractError(new Error("tx_bad_seq sequence mismatch"));
    expect(result.code).toBe("CONTRACT_SUBMISSION_FAILED");
    expect(result.retryable).toBe(true);
  });

  it("classifies 'bad_seq' as CONTRACT_SUBMISSION_FAILED, retryable", () => {
    const result = normalizeContractError(new Error("Stellar error bad_seq"));
    expect(result.code).toBe("CONTRACT_SUBMISSION_FAILED");
    expect(result.retryable).toBe(true);
  });

  it("attaches txHash when provided", () => {
    const result = normalizeContractError(new Error("Submission failed"), "txSub");
    expect(result.txHash).toBe("txSub");
  });
});

// ---------------------------------------------------------------------------
// normalizeContractError — transaction failed
// ---------------------------------------------------------------------------

describe("normalizeContractError — transaction failed", () => {
  it("classifies 'Transaction failed' as CONTRACT_EXECUTION_FAILED, not retryable", () => {
    const result = normalizeContractError(new Error("Transaction failed: contract reverted"));
    expect(result.code).toBe("CONTRACT_EXECUTION_FAILED");
    expect(result.retryable).toBe(false);
  });

  it("attaches txHash when provided", () => {
    const result = normalizeContractError(new Error("Transaction failed"), "txExec");
    expect(result.txHash).toBe("txExec");
  });
});

// ---------------------------------------------------------------------------
// normalizeContractError — wallet service unavailable
// ---------------------------------------------------------------------------

describe("normalizeContractError — wallet service unavailable", () => {
  it("classifies 'Wallet service unavailable' as WALLET_SERVICE_UNAVAILABLE, retryable", () => {
    const result = normalizeContractError(new Error("Wallet service unavailable: ECONNREFUSED"));
    expect(result.code).toBe("WALLET_SERVICE_UNAVAILABLE");
    expect(result.retryable).toBe(true);
  });

  it("attaches txHash when provided", () => {
    const result = normalizeContractError(new Error("Wallet service unavailable"), "txWallet");
    expect(result.txHash).toBe("txWallet");
  });
});

// ---------------------------------------------------------------------------
// normalizeContractError — other Error
// ---------------------------------------------------------------------------

describe("normalizeContractError — other Error", () => {
  it("classifies an unrecognised Error as WALLET_SERVICE_ERROR, not retryable", () => {
    const result = normalizeContractError(new Error("some random failure"));
    expect(result.code).toBe("WALLET_SERVICE_ERROR");
    expect(result.retryable).toBe(false);
  });

  it("preserves the original error message", () => {
    const result = normalizeContractError(new Error("random failure msg"));
    expect(result.message).toBe("random failure msg");
  });

  it("attaches txHash when provided", () => {
    const result = normalizeContractError(new Error("random"), "txRand");
    expect(result.txHash).toBe("txRand");
  });
});

// ---------------------------------------------------------------------------
// normalizeContractError — non-Error thrown values
// ---------------------------------------------------------------------------

describe("normalizeContractError — non-Error values", () => {
  it("classifies a thrown string as CONTRACT_INVOCATION_FAILED, not retryable", () => {
    const result = normalizeContractError("oops");
    expect(result.code).toBe("CONTRACT_INVOCATION_FAILED");
    expect(result.retryable).toBe(false);
  });

  it("uses generic message for thrown string", () => {
    const result = normalizeContractError("oops");
    expect(result.message).toBe("An unknown contract invocation error occurred");
  });

  it("classifies a thrown number as CONTRACT_INVOCATION_FAILED", () => {
    const result = normalizeContractError(42);
    expect(result.code).toBe("CONTRACT_INVOCATION_FAILED");
  });

  it("classifies null as CONTRACT_INVOCATION_FAILED", () => {
    const result = normalizeContractError(null);
    expect(result.code).toBe("CONTRACT_INVOCATION_FAILED");
  });

  it("classifies undefined as CONTRACT_INVOCATION_FAILED", () => {
    const result = normalizeContractError(undefined);
    expect(result.code).toBe("CONTRACT_INVOCATION_FAILED");
  });

  it("classifies a plain object as CONTRACT_INVOCATION_FAILED", () => {
    const result = normalizeContractError({ reason: "unknown" });
    expect(result.code).toBe("CONTRACT_INVOCATION_FAILED");
  });

  it("attaches txHash for non-Error values when provided", () => {
    const result = normalizeContractError("bad", "txNonErr");
    expect(result.txHash).toBe("txNonErr");
  });
});

// ---------------------------------------------------------------------------
// normalizeContractError — result is always a ContractInvocationError
// ---------------------------------------------------------------------------

describe("normalizeContractError — always returns ContractInvocationError", () => {
  const cases: Array<[string, unknown]> = [
    ["Error: simulation failed", new Error("simulation failed")],
    ["Error: Submission failed", new Error("Submission failed")],
    ["Error: tx_bad_seq", new Error("tx_bad_seq")],
    ["Error: Transaction failed", new Error("Transaction failed")],
    ["Error: Wallet service unavailable", new Error("Wallet service unavailable")],
    ["Error: other", new Error("other")],
    ["string", "thrown string"],
    ["null", null],
    ["undefined", undefined],
    ["number", 0],
  ];

  it.each(cases)("returns ContractInvocationError for %s", (_label, value) => {
    expect(normalizeContractError(value)).toBeInstanceOf(ContractInvocationError);
  });
});

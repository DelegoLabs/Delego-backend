/**
 * ContractInvocationError — structured error for Soroban contract call failures.
 *
 * Carries a machine-readable `code`, a `retryable` flag that callers use to
 * decide between 422 (permanent) and 503 (transient), and an optional `txHash`
 * when the transaction reached the network before failing.
 */
export class ContractInvocationError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly txHash?: string;

  constructor(
    message: string,
    code: string,
    retryable: boolean,
    txHash?: string,
  ) {
    super(message);
    this.name = "ContractInvocationError";
    this.code = code;
    this.retryable = retryable;
    this.txHash = txHash;
    // Restore prototype chain so `instanceof` works correctly when compiled to ES5
    Object.setPrototypeOf(this, ContractInvocationError.prototype);
  }
}

/**
 * Normalises any thrown value into a `ContractInvocationError`.
 *
 * Classification rules (applied in order):
 *  1. Already a ContractInvocationError → return as-is.
 *  2. Error whose message contains 'simulation failed' (case-insensitive)
 *     → CONTRACT_SIMULATION_FAILED, retryable: false
 *  3. Error whose message contains 'Submission failed', 'tx_bad_seq', or 'bad_seq'
 *     → CONTRACT_SUBMISSION_FAILED, retryable: true
 *  4. Error whose message contains 'Transaction failed'
 *     → CONTRACT_EXECUTION_FAILED, retryable: false
 *  5. Error whose message contains 'Wallet service unavailable'
 *     → WALLET_SERVICE_UNAVAILABLE, retryable: true
 *  6. Any other Error → WALLET_SERVICE_ERROR, retryable: false
 *  7. Non-Error thrown value → CONTRACT_INVOCATION_FAILED, retryable: false,
 *     with a generic message.
 */
export function normalizeContractError(
  err: unknown,
  txHash?: string,
): ContractInvocationError {
  if (err instanceof ContractInvocationError) {
    return err;
  }

  if (err instanceof Error) {
    const msg = err.message;

    if (/simulation failed/i.test(msg)) {
      return new ContractInvocationError(
        msg,
        "CONTRACT_SIMULATION_FAILED",
        false,
        txHash,
      );
    }

    if (
      msg.includes("Submission failed") ||
      msg.includes("tx_bad_seq") ||
      msg.includes("bad_seq")
    ) {
      return new ContractInvocationError(
        msg,
        "CONTRACT_SUBMISSION_FAILED",
        true,
        txHash,
      );
    }

    if (msg.includes("Transaction failed")) {
      return new ContractInvocationError(
        msg,
        "CONTRACT_EXECUTION_FAILED",
        false,
        txHash,
      );
    }

    if (msg.includes("Wallet service unavailable")) {
      return new ContractInvocationError(
        msg,
        "WALLET_SERVICE_UNAVAILABLE",
        true,
        txHash,
      );
    }

    return new ContractInvocationError(
      msg,
      "WALLET_SERVICE_ERROR",
      false,
      txHash,
    );
  }

  return new ContractInvocationError(
    "An unknown contract invocation error occurred",
    "CONTRACT_INVOCATION_FAILED",
    false,
    txHash,
  );
}

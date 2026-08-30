const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const CONTRACT_ADDRESS_RE = /^C[A-Z2-7]{55}$/;

export function getWalletUrl(): string {
  return process.env.WALLET_URL ?? "http://localhost:3012";
}

export function getEscrowContractId(): string {
  const contractId = process.env.ESCROW_CONTRACT_ID;
  if (!contractId) {
    throw new Error("ESCROW_CONTRACT_ID environment variable is not configured");
  }
  return contractId;
}

export function isValidStellarAddress(address: string): boolean {
  return STELLAR_ADDRESS_RE.test(address);
}

export function isValidContractId(contractId: string): boolean {
  return CONTRACT_ADDRESS_RE.test(contractId);
}

/**
 * Address authorized to submit auto-release `release` calls on behalf of the
 * platform when a delivery-confirmation webhook triggers a release rather
 * than an explicit buyer/seller-initiated request (Issue #45).
 */
export function getAutoReleaseCallerAddress(): string {
  const address =
    process.env.ESCROW_AUTO_RELEASE_CALLER_ADDRESS ??
    process.env.SETTLEMENT_SOURCE_ADDRESS;
  if (!address) {
    throw new Error(
      "ESCROW_AUTO_RELEASE_CALLER_ADDRESS or SETTLEMENT_SOURCE_ADDRESS must be configured for escrow auto-release"
    );
  }
  return address;
}

/**
 * Blend Protocol Soroban Yield Pool Lending Coordinator
 *
 * Data types and service for coordinating deposit of locked escrow funds
 * into Blend Protocol lending pools and withdrawing principal + yield on release.
 *
 * Closes #284
 */

/** Represents a supply position in a Blend Protocol lending pool. */
export interface BlendSupplyPosition {
  escrowId: string;
  poolContractId: string;
  assetAddress: string;
  depositedAmountStroops: string;
  bTokenAmount: string;
  supplyLedger: number;
}

/** Result of a deposit operation. */
export interface BlendDepositResult {
  success: boolean;
  position: BlendSupplyPosition;
  txHash?: string;
  error?: string;
}

/** Result of a withdrawal operation. */
export interface BlendWithdrawResult {
  success: boolean;
  escrowId: string;
  principalReturnedStroops: string;
  yieldEarnedStroops: string;
  totalReturnedStroops: string;
  txHash?: string;
  error?: string;
}

/** Interest accrual record for accounting. */
export interface InterestAccrualRecord {
  escrowId: string;
  poolContractId: string;
  assetAddress: string;
  principalStroops: string;
  yieldStroops: string;
  totalValueStroops: string;
  ledger: number;
  recordedAt: string;
}

/** Configuration for the Blend yield coordinator. */
export interface BlendYieldConfig {
  poolContractId: string;
  assetAddress: string;
  rpcUrl: string;
  networkPassphrase: string;
}

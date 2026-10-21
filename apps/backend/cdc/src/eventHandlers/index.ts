/**
 * Event Handlers for CDC Service
 * Issue #603 — Contract Upgrade Event Listener for Governance Security
 */

export {
  ContractUpgradeListener,
  createContractUpgradeListener,
  type ContractUpgradeEvent,
  type ApprovedWasmHash,
  type ContractConfigRecord,
  type WithdrawalPauseState,
  type ContractUpgradeListenerConfig,
  type CreateContractUpgradeListenerOptions,
} from "./contractUpgrade.js";
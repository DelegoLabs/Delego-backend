/** A delegation grants an AI agent scoped authority to act on behalf of a user */

export type ColorTag =
  | "slate"
  | "indigo"
  | "emerald"
  | "amber"
  | "rose"
  | "cyan"
  | "violet"
  | "teal";

export type DelegationStatus =
  | "pending"
  | "active"
  | "paused"
  | "revoked"
  | "expired";

export interface SpendingPolicy {
  /** Max per-transaction amount in stroops */
  maxPerTransaction: any;
  /** Max cumulative spend in stroops for this delegation */
  maxTotal: any;
  /** Allowed merchant IDs; empty = all */
  allowedMerchants: string[];
  /** Allowed product categories */
  allowedCategories?: string[];
  /** ISO 8601 expiry */
  expiresAt?: string | null;
}

export type DelegationPolicy = SpendingPolicy;

export type DelegationPermissionLevel =
  | "VIEW_ONLY"
  | "AUTO_APPROVE"
  | "SIGNER"
  | "ADMIN";

export interface Delegation {
  id: string;
  userId: string;
  agentId: string;
  walletId?: string;
  label?: string;
  colorTag?: ColorTag;
  status: DelegationStatus;
  permissionLevel?: DelegationPermissionLevel;
  expires_at_ledger?: number;
  policy: SpendingPolicy;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface CreateDelegationPolicyInput {
  /** Max per-transaction amount in stroops, as a numeric string */
  maxPerTransaction: string;
  /** Max cumulative spend in stroops, as a numeric string */
  maxTotal: string;
  allowedMerchants: string[];
  allowedCategories: string[];
  /** ISO 8601 expiry */
  expiresAt?: string;
}

export interface CreateDelegationInput {
  agentId: string;
  walletId: string;
  label: string;
  colorTag?: ColorTag;
  policy: CreateDelegationPolicyInput;
  permissionLevel: DelegationPermissionLevel;
}

export interface UpdateDelegationPolicyInput {
  maxPerTransaction?: string;
  maxTotal?: string;
  allowedMerchants?: string[];
  allowedCategories?: string[];
  expiresAt?: string;
}

export interface UpdateDelegationInput {
  status?: DelegationStatus;
  label?: string;
  colorTag?: ColorTag;
  policy?: UpdateDelegationPolicyInput;
}


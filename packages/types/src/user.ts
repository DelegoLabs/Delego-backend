/** User identity in Delego — linked to a Stellar wallet address */

export interface User {
  id: string;
  email: string | null;
  name?: string;
  walletAddress?: string;
  stellarAddress?: string;
  displayName?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface UserPreferences {
  userId?: string;
  currency?: string;
  theme?: "light" | "dark" | "system";
  notificationsEnabled?: boolean;
  /** Maximum amount (in stroops) an agent may spend without explicit approval */
  defaultSpendingLimit?: string | number | bigint;
  /** Require approval for all purchases */
  requireApproval?: boolean;
  notificationEmail?: boolean;
  notificationPush?: boolean;
}

/**
 * Server-issued data-erasure request state (#610).
 */
export interface ErasureRequest {
  /** ISO-8601 timestamp the erasure request was logged. */
  requestedAt: string;
  /** ISO-8601 timestamp — the server-authoritative date erasure finalizes if not cancelled. */
  finalizesAt: string;
  /** ISO-8601 timestamp of "now" as seen by the server when it issued this state. */
  serverTimestamp: string;
  status: "pending" | "cancelled" | "finalized";
}


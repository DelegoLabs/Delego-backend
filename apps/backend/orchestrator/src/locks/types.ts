export interface DistributedLock {
  key: string;
  owner: string;
  acquiredAt: string;
  expiresAt: string;
  metadata: Record<string, unknown>;
  fence: number;
}

export interface LockOptions {
  ttlMs: number;
  autoRenew?: boolean;
  renewIntervalMs?: number;
  metadata?: Record<string, unknown>;
  /** How long to wait for a contended lock. Default 30s. 0 = no wait. */
  waitTimeoutMs?: number;
}

export interface LockResult {
  acquired: boolean;
  lock?: DistributedLock;
  error?: string;
  waitTimeMs?: number;
}

export interface HeldLockRecord extends DistributedLock {
  stolen: boolean;
  ttlMs: number;
  autoRenew: boolean;
}

export type LockLevel = "workflow" | "step";

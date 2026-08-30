/**
 * Tracks how many delivery confirmations have been received per escrow, used
 * to drive pro-rata partial-release calculations (Issue #45).
 *
 * In-memory by default; swap for a DB/Redis-backed implementation in
 * production via {@link setConfirmationTracker}.
 */

export interface ConfirmationTracker {
  increment(escrowId: string): Promise<number>;
  get(escrowId: string): Promise<number>;
}

export class InMemoryConfirmationTracker implements ConfirmationTracker {
  private readonly counts = new Map<string, number>();

  async increment(escrowId: string): Promise<number> {
    const next = (this.counts.get(escrowId) ?? 0) + 1;
    this.counts.set(escrowId, next);
    return next;
  }

  async get(escrowId: string): Promise<number> {
    return this.counts.get(escrowId) ?? 0;
  }
}

let tracker: ConfirmationTracker = new InMemoryConfirmationTracker();

export function setConfirmationTracker(newTracker: ConfirmationTracker): void {
  tracker = newTracker;
}

export function resetConfirmationTracker(): void {
  tracker = new InMemoryConfirmationTracker();
}

export async function recordDeliveryConfirmation(escrowId: string): Promise<number> {
  return tracker.increment(escrowId);
}

export async function getConfirmationCount(escrowId: string): Promise<number> {
  return tracker.get(escrowId);
}

/**
 * Local copy of the contract-event dedup primitives used by the permission
 * event listener (issue #57).
 *
 * The notifications service and the payments service are siblings in the
 * monorepo, but they intentionally do not depend on each other at runtime.
 * Instead of consuming `@delegolabs/payments/events/dedup-store` directly, the
 * notifications service keeps a small, focused duplicate of the primitives
 * it actually needs (`deriveContractEventId` and an in-memory store).
 *
 * Keeping the source in sync with the payments package is a deliberate
 * trade-off: the surfaces are tiny (one helper function, one class with
 * three methods) and cross-package ESM resolution through the pnpm
 * workspace has been a source of build flakiness on CI.
 */

export interface ProcessedContractEventRecord {
  eventId: string;
  contractId: string;
  processedAt: string;
}

export interface ProcessedContractEventStore {
  has(eventId: string): Promise<boolean>;
  markProcessed(eventId: string, contractId: string): Promise<void>;
}

/**
 * Deterministic event id derived from the ledger tx hash and the event
 * index within that transaction. Mirrors `deriveContractEventId` in
 * `apps/backend/payments/events/dedup-store.ts`.
 */
export function deriveContractEventId(
  txHash: string,
  eventIndex: number
): string {
  return `${txHash}:${eventIndex}`;
}

/**
 * In-memory store used by tests and by the listener when no DB-backed
 * implementation has been registered. The shape matches
 * `InMemoryProcessedContractEventStore` in the payments service so unit
 * tests can be shared via JSON snapshots if needed.
 */
export class InMemoryProcessedContractEventStore
  implements ProcessedContractEventStore
{
  private readonly processed = new Map<string, ProcessedContractEventRecord>();

  async has(eventId: string): Promise<boolean> {
    return this.processed.has(eventId);
  }

  async markProcessed(eventId: string, contractId: string): Promise<void> {
    this.processed.set(eventId, {
      eventId,
      contractId,
      processedAt: new Date().toISOString(),
    });
  }

  /** Returns the stored record for an event id, if any. Test helper. */
  async get(eventId: string): Promise<ProcessedContractEventRecord | undefined> {
    return this.processed.get(eventId);
  }

  /** Number of processed events currently tracked. Test helper. */
  async size(): Promise<number> {
    return this.processed.size;
  }

  /** Clears all tracked events. Test helper. */
  async clear(): Promise<void> {
    this.processed.clear();
  }
}

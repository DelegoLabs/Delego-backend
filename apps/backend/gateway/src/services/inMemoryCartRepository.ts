/**
 * In-memory cart storage (Issue #574).
 *
 * Implements the `CartRepository` contract without a database. It is used by
 * the cart sync test suites — which exercise the real merge strategy through
 * the real service layer — and by local runs that have no database at hand.
 *
 * Transactions are serialised with a promise chain, which gives the same
 * guarantee the row lock of the Sequelize implementation provides: two
 * devices syncing at the same time are applied one after the other instead of
 * overwriting each other.
 */
import type { CartRecord, CartRepository, CartTransaction, StoredCartLine } from "./cartSyncService.js";
import { cartLineKey } from "./cartSyncService.js";

export class InMemoryCartRepository implements CartRepository {
  private readonly carts = new Map<string, CartRecord>();
  private readonly lines = new Map<string, Map<string, StoredCartLine>>();
  private queue: Promise<unknown> = Promise.resolve();

  async runInTransaction<T>(fn: (tx: CartTransaction) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => fn(this.createTransaction()));
    // Keep the chain alive after a failed transaction.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Current state of a cart — used by the tests to assert on the outcome. */
  snapshot(cartId: string): { cart: CartRecord | null; lines: StoredCartLine[] } {
    const cart = this.carts.get(cartId) ?? null;
    const lines = [...(this.lines.get(cartId)?.values() ?? [])].map((line) => ({ ...line }));
    return { cart: cart ? { ...cart } : null, lines };
  }

  private createTransaction(): CartTransaction {
    // Arrow functions so `this` stays bound to the repository.
    return {
      loadOrCreateCart: async (cartId: string, userId: string): Promise<CartRecord> => {
        const existing = this.carts.get(cartId);
        if (existing) return { ...existing };
        const cart: CartRecord = { id: cartId, userId, version: 0 };
        this.carts.set(cartId, cart);
        return { ...cart };
      },

      listLines: async (cartId: string): Promise<StoredCartLine[]> => {
        const stored = this.lines.get(cartId);
        if (!stored) return [];
        return [...stored.values()].map((line) => ({ ...line }));
      },

      saveLines: async (cartId: string, lines: StoredCartLine[]): Promise<void> => {
        const stored = this.lines.get(cartId) ?? new Map<string, StoredCartLine>();
        for (const line of lines) {
          stored.set(cartLineKey(line.merchantId, line.productId, line.skuId), { ...line });
        }
        this.lines.set(cartId, stored);
      },

      setVersion: async (cartId: string, version: number): Promise<void> => {
        const cart = this.carts.get(cartId);
        if (cart) this.carts.set(cartId, { ...cart, version });
      },
    };
  }
}

/**
 * Minimal DataLoader-style request batching (Issue #100).
 *
 * Collapses multiple `.load(key)` calls made within the same tick into one
 * batched fetch, avoiding the N+1 pattern GraphQL resolvers are prone to.
 * A dependency-free reimplementation of the core DataLoader idea (batch +
 * per-key cache); swap in the real `dataloader` package if its extra
 * features (custom cache maps, request coalescing across microtask
 * boundaries with `process.nextTick`, etc.) turn out to matter in
 * production — this covers the common case.
 */

export type BatchFn<K, V> = (keys: K[]) => Promise<Array<V | Error>>;

export class BatchLoader<K, V> {
  private cache = new Map<K, Promise<V>>();
  private pendingKeys: K[] = [];
  private pendingResolvers: Array<{
    resolve: (value: V) => void;
    reject: (err: Error) => void;
  }> = [];
  private dispatchScheduled = false;

  constructor(private batchFn: BatchFn<K, V>) {}

  /** Load a single key, batching it with any other `.load()` calls made in
   * the same microtask tick. Repeated loads of the same key within the
   * loader's lifetime return the same cached promise. */
  load(key: K): Promise<V> {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const promise = new Promise<V>((resolve, reject) => {
      this.pendingKeys.push(key);
      this.pendingResolvers.push({ resolve, reject });
    });

    this.cache.set(key, promise);
    this.scheduleDispatch();
    return promise;
  }

  /** Load multiple keys at once, still batched together with any other
   * pending loads in the same tick. */
  loadMany(keys: K[]): Promise<V[]> {
    return Promise.all(keys.map((key) => this.load(key)));
  }

  /** Drop a key's cached result, so the next `.load()` for it triggers a
   * fresh batched fetch. */
  clear(key: K): void {
    this.cache.delete(key);
  }

  clearAll(): void {
    this.cache.clear();
  }

  private scheduleDispatch(): void {
    if (this.dispatchScheduled) return;
    this.dispatchScheduled = true;
    queueMicrotask(() => this.dispatch());
  }

  private async dispatch(): Promise<void> {
    const keys = this.pendingKeys;
    const resolvers = this.pendingResolvers;
    this.pendingKeys = [];
    this.pendingResolvers = [];
    this.dispatchScheduled = false;

    if (keys.length === 0) return;

    try {
      const results = await this.batchFn(keys);
      if (results.length !== keys.length) {
        throw new Error(
          `BatchLoader batch function must return exactly one result per key: expected ${keys.length}, got ${results.length}`,
        );
      }
      results.forEach((result, i) => {
        if (result instanceof Error) {
          resolvers[i].reject(result);
        } else {
          resolvers[i].resolve(result);
        }
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const resolver of resolvers) {
        resolver.reject(error);
      }
    }
  }
}

import { describe, it, expect, vi } from "vitest";
import { BatchLoader } from "./batchLoader.js";

describe("BatchLoader", () => {
  it("batches multiple load() calls made in the same tick into one batch function call", async () => {
    const batchFn = vi.fn(async (keys: string[]) => keys.map((k) => `value-${k}`));
    const loader = new BatchLoader(batchFn);

    const [a, b, c] = await Promise.all([loader.load("1"), loader.load("2"), loader.load("3")]);

    expect(batchFn).toHaveBeenCalledTimes(1);
    expect(batchFn).toHaveBeenCalledWith(["1", "2", "3"]);
    expect([a, b, c]).toEqual(["value-1", "value-2", "value-3"]);
  });

  it("caches repeated loads of the same key, calling the batch fn only once", async () => {
    const batchFn = vi.fn(async (keys: string[]) => keys.map((k) => `value-${k}`));
    const loader = new BatchLoader(batchFn);

    const [a, b] = await Promise.all([loader.load("1"), loader.load("1")]);
    expect(batchFn).toHaveBeenCalledTimes(1);
    expect(batchFn).toHaveBeenCalledWith(["1"]);
    expect(a).toBe(b);
  });

  it("issues a fresh batch for load() calls made after the previous batch dispatched", async () => {
    const batchFn = vi.fn(async (keys: string[]) => keys.map((k) => `value-${k}`));
    const loader = new BatchLoader(batchFn);

    await loader.load("1");
    await loader.load("2");

    expect(batchFn).toHaveBeenCalledTimes(2);
  });

  it("loadMany batches all requested keys together", async () => {
    const batchFn = vi.fn(async (keys: number[]) => keys.map((k) => k * 10));
    const loader = new BatchLoader(batchFn);

    const results = await loader.loadMany([1, 2, 3]);
    expect(results).toEqual([10, 20, 30]);
    expect(batchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects only the specific key's promise when the batch fn returns an Error for it", async () => {
    const batchFn = vi.fn(async (keys: string[]) =>
      keys.map((k) => (k === "bad" ? new Error(`no such key: ${k}`) : `value-${k}`)),
    );
    const loader = new BatchLoader(batchFn);

    const results = await Promise.allSettled([loader.load("good"), loader.load("bad")]);
    expect(results[0]).toEqual({ status: "fulfilled", value: "value-good" });
    expect(results[1].status).toBe("rejected");
  });

  it("rejects all pending promises in the batch if the batch fn itself throws", async () => {
    const batchFn = vi.fn(async () => {
      throw new Error("upstream service unavailable");
    });
    const loader = new BatchLoader(batchFn);

    const results = await Promise.allSettled([loader.load("1"), loader.load("2")]);
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");
  });

  it("throws a clear error if the batch fn returns a mismatched result count", async () => {
    const batchFn = vi.fn(async () => ["only-one-result"]);
    const loader = new BatchLoader(batchFn);

    const results = await Promise.allSettled([loader.load("1"), loader.load("2")]);
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");
  });

  it("clear() removes a key from cache so the next load re-fetches it", async () => {
    let callCount = 0;
    const batchFn = vi.fn(async (keys: string[]) => {
      callCount += 1;
      return keys.map(() => `call-${callCount}`);
    });
    const loader = new BatchLoader(batchFn);

    const first = await loader.load("1");
    loader.clear("1");
    const second = await loader.load("1");

    expect(first).toBe("call-1");
    expect(second).toBe("call-2");
  });

  it("clearAll() resets the entire cache", async () => {
    const batchFn = vi.fn(async (keys: string[]) => keys.map((k) => `value-${k}`));
    const loader = new BatchLoader(batchFn);

    await loader.load("1");
    loader.clearAll();
    await loader.load("1");

    expect(batchFn).toHaveBeenCalledTimes(2);
  });

  it("returns an empty array from loadMany([]) without calling the batch function", async () => {
    const batchFn = vi.fn(async (keys: string[]) => keys.map((k) => `value-${k}`));
    const loader = new BatchLoader(batchFn);

    await expect(loader.loadMany([])).resolves.toEqual([]);
    expect(batchFn).not.toHaveBeenCalled();
  });

  it("deduplicates repeated keys passed to a single loadMany() call", async () => {
    const batchFn = vi.fn(async (keys: string[]) => keys.map((k) => `value-${k}`));
    const loader = new BatchLoader(batchFn);

    const results = await loader.loadMany(["1", "1", "2"]);

    expect(results).toEqual(["value-1", "value-1", "value-2"]);
    expect(batchFn).toHaveBeenCalledOnce();
    expect(batchFn).toHaveBeenCalledWith(["1", "2"]);
  });

  it("batches interleaved load() and loadMany() calls in the same tick", async () => {
    const batchFn = vi.fn(async (keys: string[]) => keys.map((k) => `value-${k}`));
    const loader = new BatchLoader(batchFn);

    const first = loader.load("1");
    const many = loader.loadMany(["2", "3"]);
    const last = loader.load("4");
    const results = await Promise.all([first, many, last]);

    expect(results).toEqual(["value-1", ["value-2", "value-3"], "value-4"]);
    expect(batchFn).toHaveBeenCalledOnce();
    expect(batchFn).toHaveBeenCalledWith(["1", "2", "3", "4"]);
  });

  it("preserves each result's position when only one key returns an Error", async () => {
    const failure = new Error("missing key");
    const batchFn = vi.fn(async () => [failure, "value-2", "value-3"]);
    const loader = new BatchLoader(batchFn);

    const results = await Promise.allSettled([loader.load("1"), loader.load("2"), loader.load("3")]);

    expect(results[0]).toEqual({ status: "rejected", reason: failure });
    expect(results[1]).toEqual({ status: "fulfilled", value: "value-2" });
    expect(results[2]).toEqual({ status: "fulfilled", value: "value-3" });
  });

  it("normalizes a non-Error rejection from the batch function", async () => {
    const batchFn = vi.fn(async () => {
      throw "upstream unavailable";
    });
    const loader = new BatchLoader(batchFn);

    const results = await Promise.allSettled([loader.load("1"), loader.load("2")]);

    expect(results[0]).toEqual({ status: "rejected", reason: new Error("upstream unavailable") });
    expect(results[1]).toEqual({ status: "rejected", reason: new Error("upstream unavailable") });
  });

  it("rejects with a clear error when the batch function returns too many results", async () => {
    const batchFn = vi.fn(async () => ["one", "two", "three"]);
    const loader = new BatchLoader(batchFn);

    const results = await Promise.allSettled([loader.load("1"), loader.load("2")]);

    expect(results[0]).toEqual({
      status: "rejected",
      reason: new Error("BatchLoader batch function must return exactly one result per key: expected 2, got 3"),
    });
    expect(results[1]).toEqual(results[0]);
  });

  it("caches a rejected promise until the key is cleared", async () => {
    const failure = new Error("missing key");
    const batchFn = vi.fn(async () => [failure]);
    const loader = new BatchLoader(batchFn);

    await expect(loader.load("1")).rejects.toBe(failure);
    await expect(loader.load("1")).rejects.toBe(failure);
    expect(batchFn).toHaveBeenCalledOnce();

    loader.clear("1");
    await expect(loader.load("1")).rejects.toBe(failure);
    expect(batchFn).toHaveBeenCalledTimes(2);
  });

  it("re-batches a key cleared before its pending batch dispatches", async () => {
    const batchFn = vi.fn(async (keys: string[]) => keys.map((k) => `value-${k}`));
    const loader = new BatchLoader(batchFn);

    const first = loader.load("1");
    loader.clear("1");
    const second = loader.load("1");

    await expect(first).resolves.toBe("value-1");
    await expect(second).resolves.toBe("value-1");
    expect(batchFn).toHaveBeenCalledOnce();
    expect(batchFn).toHaveBeenCalledWith(["1", "1"]);
  });
});

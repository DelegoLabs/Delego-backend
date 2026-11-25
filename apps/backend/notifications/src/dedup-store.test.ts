import { describe, it, expect } from "vitest";
import {
  deriveContractEventId,
  InMemoryProcessedContractEventStore,
} from "./dedup-store.js";

describe("deriveContractEventId", () => {
  it("combines tx hash and event index deterministically", () => {
    expect(deriveContractEventId("abc123", 0)).toBe("abc123:0");
    expect(deriveContractEventId("abc123", 7)).toBe("abc123:7");
  });

  it("returns the same id for identical inputs", () => {
    expect(deriveContractEventId("hash", 2)).toBe(
      deriveContractEventId("hash", 2)
    );
  });

  it("produces distinct ids for different event indexes within one tx", () => {
    expect(deriveContractEventId("hash", 0)).not.toBe(
      deriveContractEventId("hash", 1)
    );
  });

  it("produces distinct ids for different tx hashes at the same index", () => {
    expect(deriveContractEventId("a", 0)).not.toBe(
      deriveContractEventId("b", 0)
    );
  });
});

describe("InMemoryProcessedContractEventStore", () => {
  it("reports unseen events as not processed", async () => {
    const store = new InMemoryProcessedContractEventStore();
    expect(await store.has("evt-1")).toBe(false);
  });

  it("reports an event as processed after markProcessed", async () => {
    const store = new InMemoryProcessedContractEventStore();
    await store.markProcessed("evt-1", "contract-A");
    expect(await store.has("evt-1")).toBe(true);
  });

  it("keeps events independent of one another", async () => {
    const store = new InMemoryProcessedContractEventStore();
    await store.markProcessed("evt-1", "contract-A");
    expect(await store.has("evt-2")).toBe(false);
  });

  it("is idempotent when the same event is marked twice", async () => {
    const store = new InMemoryProcessedContractEventStore();
    await store.markProcessed("evt-1", "contract-A");
    await store.markProcessed("evt-1", "contract-A");
    expect(await store.has("evt-1")).toBe(true);
  });

  it("overwrites the record on re-mark while preserving the processed flag", async () => {
    const store = new InMemoryProcessedContractEventStore();
    await store.markProcessed("evt-1", "contract-A");
    await store.markProcessed("evt-1", "contract-B");
    expect(await store.has("evt-1")).toBe(true);
  });
});

import { describe, it, expect } from "vitest";

import { InMemorySchemaEvolutionStore } from "./schemaEvolution.js";

describe("InMemorySchemaEvolutionStore", () => {
  it("starts at version 0 and assigns incrementing versions on layout change", async () => {
    const store = new InMemorySchemaEvolutionStore();
    expect(await store.currentVersion("public", "orders")).toBe(0);

    const v1 = await store.recordLayout("public", "orders", { id: "int", amount: "int" });
    expect(v1.version).toBe(1);
    expect(await store.currentVersion("public", "orders")).toBe(1);

    // Same layout -> no new version.
    const again = await store.recordLayout("public", "orders", { amount: "int", id: "int" });
    expect(again.version).toBe(1);

    // New column -> version 2.
    const v2 = await store.recordLayout("public", "orders", {
      id: "int",
      amount: "int",
      status: "text",
    });
    expect(v2.version).toBe(2);
  });

  it("tracks multiple tables independently", async () => {
    const store = new InMemorySchemaEvolutionStore();
    await store.recordLayout("public", "orders", { id: "int" });
    await store.recordLayout("public", "wallets", { id: "int" });
    expect(await store.currentVersion("public", "orders")).toBe(1);
    expect(await store.currentVersion("public", "wallets")).toBe(1);
  });

  it("remembers per-version layouts", async () => {
    const store = new InMemorySchemaEvolutionStore();
    await store.recordLayout("public", "orders", { id: "int" });
    await store.recordLayout("public", "orders", { id: "int", status: "text" });
    const v1 = await store.getVersion("public", "orders", 1);
    const v2 = await store.getVersion("public", "orders", 2);
    expect(v1!.columns).toEqual({ id: "int" });
    expect(v2!.columns).toEqual({ id: "int", status: "text" });
  });
});

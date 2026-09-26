/**
 * Tests for #68 — encryption performance benchmark and the <2ms budget.
 */
import { describe, it, expect, vi } from "vitest";
import { runEncryptionBenchmark, printEncryptionBenchmark } from "./benchmark.js";

describe("runEncryptionBenchmark", () => {
  it("returns aggregate stats within the <2ms per-field budget", async () => {
    const result = await runEncryptionBenchmark({ iterations: 200, payloadLength: 64 });
    expect(result.iterations).toBe(200);
    expect(result.opsPerSec).toBeGreaterThan(0);
    expect(result.encrypt.avgMs).toBeGreaterThan(0);
    expect(result.decrypt.avgMs).toBeGreaterThan(0);
    // The issue's acceptance criterion — p95 encrypt/decrypt < 2ms.
    expect(result.underBudget).toBe(true);
    expect(result.encrypt.p95Ms).toBeLessThan(2);
    expect(result.decrypt.p95Ms).toBeLessThan(2);
  });

  it("always produces p50 <= p95 <= max ordering", async () => {
    const result = await runEncryptionBenchmark({ iterations: 150 });
    for (const group of [result.encrypt, result.decrypt]) {
      expect(group.p50Ms).toBeLessThanOrEqual(group.p95Ms);
      expect(group.p95Ms).toBeLessThanOrEqual(group.maxMs);
    }
  });
});

describe("printEncryptionBenchmark", () => {
  it("prints a human-readable summary", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await printEncryptionBenchmark({ iterations: 100 });
    expect(logSpy).toHaveBeenCalled();
    const rendered = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(rendered).toContain("Encryption benchmark");
    expect(rendered).toContain("encrypt");
    expect(rendered).toContain("decrypt");
    logSpy.mockRestore();
  });
});
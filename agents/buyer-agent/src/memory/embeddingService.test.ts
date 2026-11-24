import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EmbeddingService } from "./embeddingService";

const DIMENSIONS = 4;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function successBody(vector: number[] = [0.1, 0.2, 0.3, 0.4]) {
  return { data: [{ index: 0, embedding: vector }] };
}

describe("EmbeddingService", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function createService(overrides: Record<string, unknown> = {}) {
    return new EmbeddingService({
      apiKey: "test-key",
      baseUrl: "https://api.embeddings.test/v1",
      model: "test-model",
      dimensions: DIMENSIONS,
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      ...overrides,
    } as any);
  }

  it("returns the embedding on a successful response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, successBody()));
    const service = createService();

    const result = await service.embed("hello");

    expect(result).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and succeeds on a later attempt", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { error: "rate limited" }))
      .mockResolvedValueOnce(jsonResponse(200, successBody()));
    const service = createService();

    const promise = service.embed("hello");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx responses", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, { error: "boom" }))
      .mockResolvedValueOnce(jsonResponse(503, { error: "unavailable" }))
      .mockResolvedValueOnce(jsonResponse(200, successBody()));
    const service = createService();

    const promise = service.embed("hello");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-retryable 4xx errors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: "bad request" }));
    const service = createService();

    await expect(service.embed("hello")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries and throws", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(503, { error: "unavailable" }));
    const service = createService({ maxRetries: 2 });

    const promise = service.embed("hello");
    const assertion = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;

    // initial attempt + 2 retries
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses exponential backoff bounded by maxDelayMs", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(429, { error: "rate limited" }));
    const service = createService({ maxRetries: 4, baseDelayMs: 100, maxDelayMs: 300 });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const promise = service.embed("hello");
    const assertion = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;

    const delays = setTimeoutSpy.mock.calls.map((call) => call[1] as number);
    expect(delays.length).toBeGreaterThanOrEqual(4);
    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(300);
    }
    // second delay should be at least as large as the first (exponential growth, capped)
    expect(delays[1]).toBeGreaterThanOrEqual(delays[0]);
  });

  it("rejects a response whose dimension does not match the configured dimensions", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, successBody([0.1, 0.2, 0.3])));
    const service = createService();

    await expect(service.embed("hello")).rejects.toThrow(/dimension/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a response whose dimension matches the configured dimensions", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, successBody([1, 2, 3, 4])));
    const service = createService();

    await expect(service.embed("hello")).resolves.toHaveLength(DIMENSIONS);
  });
});

/**
 * Unit tests for ConnectionSupervisor: ledger tracking, streaming → polling
 * failover, reconnect attempts, and the optional `nowLedger` dependency.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionSupervisor,
  type ConnectionSupervisorDependencies,
  type ConnectionSupervisorOptions,
  type PollFactory,
  type PollResult,
  type StreamFactory,
} from "./connectionSupervisor.js";

const RECONNECT_INTERVAL_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 1_000;
const POLLING_INTERVAL_MS = 5_000;

/** Private members exercised via prototype spies. */
interface SupervisorInternals {
  trackMessageLedger(message: unknown): void;
  attemptReconnect(): Promise<void>;
}

interface FakeStream {
  url: string;
  message: (message: unknown) => void;
  open: () => void;
  closeWith: (error?: Error) => void;
  close: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
}

function createStreamHarness() {
  const streams: FakeStream[] = [];
  const createStream = vi.fn<StreamFactory>((url, onMessage, onOpen, onClose) => {
    const stream: FakeStream = {
      url,
      message: onMessage,
      open: onOpen,
      closeWith: onClose,
      close: vi.fn(),
      ping: vi.fn(),
    };
    streams.push(stream);
    return { close: stream.close, ping: stream.ping };
  });
  return { streams, createStream };
}

function buildSupervisor(
  overrides: Partial<ConnectionSupervisorOptions> = {},
  dependencies: ConnectionSupervisorDependencies = {},
) {
  const harness = createStreamHarness();
  const poll = vi.fn<PollFactory>(async (): Promise<PollResult> => ({ events: [] }));
  const supervisor = new ConnectionSupervisor(
    {
      streamUrl: "wss://horizon.test/stream",
      pollingUrl: "https://horizon.test/poll",
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      pollingIntervalMs: POLLING_INTERVAL_MS,
      mode: "streaming",
      ...overrides,
    },
    { createStream: harness.createStream, poll, ...dependencies },
  );
  const errors: unknown[] = [];
  const modeChanges: string[] = [];
  supervisor.on("error", (error) => errors.push(error));
  supervisor.on("modeChange", (mode: string) => modeChanges.push(mode));
  return { supervisor, poll, errors, modeChanges, ...harness };
}

/** Advance fake time while answering every heartbeat, keeping the stream healthy. */
async function advanceWithPongs(stream: FakeStream, totalMs: number): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += HEARTBEAT_INTERVAL_MS) {
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    stream.message({ type: "pong" });
  }
}

const internals = ConnectionSupervisor.prototype as unknown as SupervisorInternals;

describe("ConnectionSupervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("ledger tracking", () => {
    it("tracks the ledger of each streamed message exactly once and dispatches it", () => {
      const trackSpy = vi.spyOn(internals, "trackMessageLedger");
      const { supervisor, streams } = buildSupervisor();
      const streamed: unknown[] = [];
      supervisor.on("stream", (data) => streamed.push(data));

      supervisor.start();
      streams[0].open();
      const message = { type: "transaction", ledger: 1234 };
      streams[0].message(message);

      expect(trackSpy).toHaveBeenCalledTimes(1);
      expect(trackSpy).toHaveBeenCalledWith(message);
      expect(supervisor.getLastSeenLedger()).toBe(1234);
      expect(streamed).toEqual([message]);

      streams[0].message({ type: "transaction", ledger: 1240 });
      expect(trackSpy).toHaveBeenCalledTimes(2);
      expect(supervisor.getLastSeenLedger()).toBe(1240);
      supervisor.stop();
    });

    it("does not track or dispatch heartbeat ping/pong frames", () => {
      const trackSpy = vi.spyOn(internals, "trackMessageLedger");
      const { supervisor, streams } = buildSupervisor();
      const events: unknown[] = [];
      supervisor.on("event", (event) => events.push(event));

      supervisor.start();
      streams[0].open();
      streams[0].message({ type: "PONG", ledger: 999 });
      streams[0].message({ type: "ping" });

      expect(trackSpy).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
      expect(supervisor.getLastSeenLedger()).toBeUndefined();
      supervisor.stop();
    });

    it("ignores messages without a numeric ledger, keeping the last known value", () => {
      const { supervisor, streams } = buildSupervisor();
      supervisor.start();
      streams[0].open();

      streams[0].message({ type: "transaction", ledger: 50 });
      streams[0].message({ type: "transaction", ledger: "51" });
      streams[0].message("raw-string-payload");
      streams[0].message(null);

      expect(supervisor.getLastSeenLedger()).toBe(50);
      supervisor.stop();
    });

    it("tracks ledgers from polled events", async () => {
      const { supervisor, poll } = buildSupervisor({ mode: "polling" });
      poll.mockResolvedValueOnce({ events: [{ ledger: 10 }, { ledger: 11 }], cursor: "c1" });

      supervisor.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(poll).toHaveBeenCalledWith("https://horizon.test/poll", undefined);
      expect(supervisor.getLastSeenLedger()).toBe(11);

      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
      expect(poll).toHaveBeenLastCalledWith("https://horizon.test/poll", "c1");
      supervisor.stop();
    });
  });

  describe("reconnection attempts", () => {
    it("falls back to polling on stream error and reconnects to streaming on the next interval", async () => {
      const reconnectSpy = vi.spyOn(internals, "attemptReconnect");
      const { supervisor, streams, createStream, poll, errors, modeChanges } = buildSupervisor();

      supervisor.start();
      streams[0].open();
      const failure = new Error("socket dropped");
      streams[0].closeWith(failure);

      expect(errors).toEqual([failure]);
      expect(supervisor.currentMode).toBe("polling");
      expect(modeChanges).toEqual(["polling"]);
      await vi.advanceTimersByTimeAsync(0);
      expect(poll).toHaveBeenCalledTimes(1);
      expect(reconnectSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS);
      expect(reconnectSpy).toHaveBeenCalledTimes(1);
      expect(createStream).toHaveBeenCalledTimes(2);
      expect(streams[1].url).toBe("wss://horizon.test/stream");

      streams[1].open();
      await vi.advanceTimersByTimeAsync(0);
      expect(supervisor.currentMode).toBe("streaming");
      expect(modeChanges).toEqual(["polling", "streaming"]);

      // Reconnected stream carries ledger tracking, and polling/reconnect timers are cleared.
      streams[1].message({ type: "transaction", ledger: 77 });
      expect(supervisor.getLastSeenLedger()).toBe(77);
      const pollsAfterReconnect = poll.mock.calls.length;
      await advanceWithPongs(streams[1], RECONNECT_INTERVAL_MS * 2);
      expect(supervisor.currentMode).toBe("streaming");
      expect(poll).toHaveBeenCalledTimes(pollsAfterReconnect);
      expect(reconnectSpy).toHaveBeenCalledTimes(1);
      supervisor.stop();
    });

    it("keeps retrying on the reconnect interval while reconnects fail", async () => {
      const reconnectSpy = vi.spyOn(internals, "attemptReconnect");
      const { supervisor, streams, createStream, errors } = buildSupervisor();

      supervisor.start();
      streams[0].closeWith(new Error("initial failure"));

      await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS);
      expect(reconnectSpy).toHaveBeenCalledTimes(1);
      streams[1].closeWith(new Error("still down"));
      await vi.advanceTimersByTimeAsync(0);

      expect(streams[1].close).toHaveBeenCalled();
      expect(supervisor.currentMode).toBe("polling");
      expect(errors.map((e) => (e as Error).message)).toEqual(["initial failure", "still down"]);

      await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS);
      expect(reconnectSpy).toHaveBeenCalledTimes(2);
      expect(createStream).toHaveBeenCalledTimes(3);

      // A close without an error during reconnect is still reported as a failure.
      streams[2].closeWith();
      await vi.advanceTimersByTimeAsync(0);
      expect((errors[2] as Error).message).toBe("Stream closed during reconnect");
      supervisor.stop();
    });

    it("schedules reconnects after missed heartbeats trigger polling fallback", async () => {
      const reconnectSpy = vi.spyOn(internals, "attemptReconnect");
      const { supervisor, streams, modeChanges } = buildSupervisor();

      supervisor.start();
      streams[0].open();
      // Three unanswered pings, then the threshold check on the fourth tick.
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 4);

      expect(streams[0].ping).toHaveBeenCalledTimes(3);
      expect(streams[0].close).toHaveBeenCalled();
      expect(modeChanges).toEqual(["polling"]);

      await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS);
      expect(reconnectSpy).toHaveBeenCalledTimes(1);
      supervisor.stop();
    });

    it("does not attempt to reconnect while the stream stays healthy", async () => {
      const reconnectSpy = vi.spyOn(internals, "attemptReconnect");
      const { supervisor, streams, createStream } = buildSupervisor();

      supervisor.start();
      streams[0].open();
      await advanceWithPongs(streams[0], RECONNECT_INTERVAL_MS * 2);
      expect(supervisor.currentMode).toBe("streaming");
      expect(reconnectSpy).not.toHaveBeenCalled();
      expect(createStream).toHaveBeenCalledTimes(1);
      supervisor.stop();
    });

    it("does not reconnect when the stream closes after stop()", async () => {
      const reconnectSpy = vi.spyOn(internals, "attemptReconnect");
      const { supervisor, streams, modeChanges } = buildSupervisor();

      supervisor.start();
      streams[0].open();
      supervisor.stop();
      streams[0].closeWith();

      await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS * 2);
      expect(modeChanges).toEqual([]);
      expect(reconnectSpy).not.toHaveBeenCalled();
    });

    it("stops pending reconnect attempts once stopped in polling mode", async () => {
      const reconnectSpy = vi.spyOn(internals, "attemptReconnect");
      const { supervisor, streams, createStream } = buildSupervisor();

      supervisor.start();
      streams[0].closeWith(new Error("drop"));
      supervisor.stop();

      await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS * 2);
      expect(reconnectSpy).not.toHaveBeenCalled();
      expect(createStream).toHaveBeenCalledTimes(1);
    });
  });

  describe("nowLedger fallback", () => {
    it("returns undefined when no ledger has been seen and nowLedger is not provided", () => {
      const { supervisor } = buildSupervisor();
      expect(supervisor.getLastSeenLedger()).toBeUndefined();
    });

    it("falls back to nowLedger until a ledger is observed", () => {
      const nowLedger = vi.fn(() => 500);
      const { supervisor, streams } = buildSupervisor({}, { nowLedger });

      expect(supervisor.getLastSeenLedger()).toBe(500);
      expect(nowLedger).toHaveBeenCalledTimes(1);

      supervisor.start();
      streams[0].open();
      streams[0].message({ type: "transaction", ledger: 612 });

      expect(supervisor.getLastSeenLedger()).toBe(612);
      expect(nowLedger).toHaveBeenCalledTimes(1);
      supervisor.stop();
    });

    it("treats an explicitly undefined nowLedger the same as omitting it", () => {
      const { supervisor } = buildSupervisor({}, { nowLedger: undefined });
      expect(supervisor.getLastSeenLedger()).toBeUndefined();
    });
  });
});

import { EventEmitter } from "events";

export interface ConnectionSupervisorOptions {
  streamUrl: string;
  pollingUrl: string;
  heartbeatIntervalMs: number;
  pollingIntervalMs: number;
  mode: "streaming" | "polling";
}

export type SupervisorMode = "streaming" | "polling";

export interface SupervisorEvent {
  type: "stream" | "poll";
  data: unknown;
}

export type SupervisorEventHandler = (event: SupervisorEvent) => void | Promise<void>;

export type StreamFactory = (
  url: string,
  onMessage: (message: unknown) => void,
  onOpen: () => void,
  onClose: (error?: Error) => void,
) => StreamHandle;

export interface StreamHandle {
  close: () => void;
  ping?: () => void;
}

export type PollFactory = (url: string, cursor?: string) => Promise<PollResult>;

export interface PollResult {
  events: unknown[];
  cursor?: string;
}

export interface ConnectionSupervisorDependencies {
  createStream?: StreamFactory;
  poll?: PollFactory;
  nowLedger?: () => number;
}

const MISSED_PING_THRESHOLD = 3;
const RECONNECT_INTERVAL_MS = 60_000;

const defaultCreateStream: StreamFactory = (url, onMessage, onOpen, onClose) => {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available in this environment");
  }
  const socket = new WebSocket(url);
  socket.addEventListener("open", () => onOpen());
  socket.addEventListener("message", (event) => {
    try {
      const payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      onMessage(payload);
    } catch {
      onMessage(event.data);
    }
  });
  socket.addEventListener("error", () => onClose(new Error("WebSocket error")));
  socket.addEventListener("close", () => onClose());
  return {
    close: () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    },
    ping: () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping" }));
      }
    },
  };
};

const defaultPoll: PollFactory = async (url, cursor) => {
  const requestUrl = cursor ? `${url}${url.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}` : url;
  const response = await fetch(requestUrl, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Polling request failed with status ${response.status}`);
  }
  const body = (await response.json()) as { _embedded?: { records?: unknown[] }; cursor?: string };
  const events = body._embedded?.records ?? (Array.isArray(body) ? (body as unknown[]) : []);
  return { events, cursor: body.cursor };
};

export class ConnectionSupervisor extends EventEmitter {
  private readonly options: ConnectionSupervisorOptions;
  private readonly dependencies: Required<ConnectionSupervisorDependencies>;
  private mode: SupervisorMode;
  private stream?: StreamHandle;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private pollingTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setInterval>;
  private missedPings = 0;
  private cursor?: string;
  private started = false;
  private pollingInFlight = false;
  private lastSeenLedger?: number;

  constructor(options: ConnectionSupervisorOptions, dependencies: ConnectionSupervisorDependencies = {}) {
    super();
    this.options = options;
    this.mode = options.mode;
    this.dependencies = {
      createStream: dependencies.createStream ?? defaultCreateStream,
      poll: dependencies.poll ?? defaultPoll,
      nowLedger: dependencies.nowLedger,
    };
  }

  get currentMode(): SupervisorMode {
    return this.mode;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    if (this.mode === "streaming") {
      this.startStreaming();
    } else {
      this.startPolling();
    }
  }

  stop(): void {
    this.started = false;
    this.clearHeartbeat();
    this.clearPolling();
    this.clearReconnect();
    this.closeStream();
  }

  private startStreaming(): void {
    this.closeStream();
    this.missedPings = 0;
    try {
      this.stream = this.dependencies.createStream(
        this.options.streamUrl,
        (message) => this.handleStreamMessage(message),
        () => this.handleStreamOpen(),
        (error) => this.handleStreamClose(error),
      );
    } catch (error) {
      this.emit("error", error);
      this.switchToPolling();
    }
  }

  private handleStreamOpen(): void {
    this.missedPings = 0;
    this.startHeartbeat();
  }

  private handleStreamMessage(message: unknown): void {
    this.missedPings = 0;
    const type = this.extractType(message);
    if (type === "ping" || type === "pong") {
      return;
    }
    this.trackLessageLedger(message);
    this.dispatchEvent({
      type: "stream",
      data: message,
    });
  }

  private handleStreamClose(error?: Error): void {
    this.clearHeartbeat();
    this.stream = undefined;
    if (error) {
      this.emit("error", error);
    }
    if (!this.started) {
      return;
    }
    this.switchToPolling();
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.mode !== "streaming") {
        return;
      }
      if (this.missedPings >= MISSED_PING_THRESHOLD) {
        this.switchToPolling();
        return;
      }
      this.missedPings += 1;
      try {
        this.stream?.ping?.();
      } catch {
        this.switchToPolling();
      }
    }, this.options.heartbeatIntervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private switchToPolling(): void {
    if (!this.started || this.mode === "polling") {
      return;
    }
    this.mode = "polling";
    this.clearHeartbeat();
    this.closeStream();
    this.emit("modeChange", "polling");
    this.startPolling();
    this.scheduleReconnect();
  }

  private startPolling(): void {
    this.clearPolling();
    void this.runPoll();
    this.pollingTimer = setInterval(() => {
      void this.runPoll();
    }, this.options.pollingIntervalMs);
  }

  private clearPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
  }

  private async runPoll(): Promise<void> {
    if (!this.started || this.pollingInFlight) {
      return;
    }
    this.pollingInFlight = true;
    try {
      const result = await this.dependencies.poll(this.options.pollingUrl, this.cursor);
      for (const event of result.events) {
        this.trackMessageLedger(event);
        this.dispatchEvent({ type: "poll", data: event });
      }
      if (result.cursor) {
        this.cursor = result.cursor;
      }
    } catch (error) {
      this.emit("error", error);
    } finally {
      this.pollingInFlight = false;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    this.reconnectTimer = setInterval(() => {
      void this.attempReconnect();
    }, RECONNECT_INTERVAL_MS);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private async attemptReconnect(): Promise<void> {
    if (!this.started || this.mode !== "polling") {
      return;
    }
    try {
      await this.reconnectStream();
    } catch (error) {
      this.emit("error", error);
    }
  }

  private reconnectStream(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const handle = this.dependencies.createStream(
          this.options.streamUrl,
          (message) => {
            this.missedPings = 0;
            const type = this.extractType(message);
            if (type === "ping" || type === "pong") {
              return;
            }
            this.trackMessageLedger(message);
            this.dispatchEvent({ type: "stream", data: message });
          },
          () => {
            this.switchBackToStreaming(handle);
            resolve();
          },
          (error) => {
            handle.close();
            reject(error ?? new Error("Stream closed during reconnect"));
          },
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  private switchBackToStreaming(handle: StreamHandle): void {
    if (!this.started || this.mode === "streaming") {
      handle.close();
      return;
    }
    this.clearPolling();
    this.clearReconnect();
    this.stream = handle;
    this.mode = "streaming";
    this.missedPings = 0;
    this.startHeartbeat();
    this.emit("modeChange", "streaming");
  }

  private closeStream(): void {
    if (this.stream) {
      try {
        this.stream.close();
      } catch {
        // ignore close errors
      }
      this.stream = undefined;
    }
  }

  private dispatchEvent(event: SupervisorEvent): void {
    this.emit("event", event);
    this.emit(event.type, event.data);
  }

  private extractType(message: unknown): string | undefined {
    if (message && typeof message === "object" && "type" in message) {
      const type = (message as { type?: unknown }).type;
      return typeof type === "string" ? type.toLowerCase() : undefined;
    }
    return undefined;
  }

  private trackMessageLedger(message: unknown): void {
    if (!message || typeof message !== "object") {
      return;
    }
    const candidate = message as { ledger?: unknown };
    if (typeof candidate.ledger === "number") {
      this.lastSeenLedger = candidate.ledger;
    }
  }

  getLastSeenLedger(): number | undefined {
    return this.lastSeenLedger ?? this.dependencies.nowLedger?.();
  }
}

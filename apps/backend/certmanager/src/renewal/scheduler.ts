import type { CertificateService } from "../service.js";

export interface RenewalSchedulerOptions {
  intervalMs?: number;
  /** Overrides the clock for deterministic tests. */
  now?: () => Date;
  onError?: (err: unknown) => void;
}

/**
 * Periodically triggers renewal of certificates whose `nextRenewalAt` is due.
 * `tick()` is exposed for deterministic tests; `start()` runs on a timer.
 */
export class RenewalScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly onError?: (err: unknown) => void;

  constructor(
    private readonly service: CertificateService,
    options: RenewalSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 1000 * 60 * 60 * 12;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError;
  }

  async tick(): Promise<{ renewed: number; failed: number }> {
    return this.service.renewDueCertificates(this.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.onError?.(err));
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

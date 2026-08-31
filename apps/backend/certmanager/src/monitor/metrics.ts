import type { CertificateMetrics } from "@delegolabs/types";
import type { CertificateStore } from "../store/certificateStore.js";

export interface RenewalRecord {
  certId: string;
  success: boolean;
  durationMs: number;
  at: string;
}

/**
 * Tracks renewal attempts in memory so success rate, average duration and
 * failure counts can be surfaced via metrics. In production this would be
 * backed by a durable store; the tracker is injectable for assertions in tests.
 */
export class RenewalTracker {
  private readonly records: RenewalRecord[] = [];

  record(record: RenewalRecord): void {
    this.records.push(record);
  }

  history(): readonly RenewalRecord[] {
    return this.records;
  }

  reset(): void {
    this.records.length = 0;
  }
}

export async function computeMetrics(
  store: CertificateStore,
  tracker: RenewalTracker,
): Promise<CertificateMetrics> {
  const certs = await store.list();
  const records = tracker.history();

  const successful = records.filter((r) => r.success);
  const failed = records.filter((r) => !r.success);

  const renewalSuccessRate = records.length === 0
    ? 1
    : successful.length / records.length;

  const avgRenewalTimeMs = successful.length === 0
    ? 0
    : Math.round(successful.reduce((sum, r) => sum + r.durationMs, 0) / successful.length);

  return {
    totalCertificates: certs.length,
    expiringSoon: certs.filter((c) => c.status === "expiring").length,
    expired: certs.filter((c) => c.status === "expired").length,
    renewalSuccessRate: Number(renewalSuccessRate.toFixed(4)),
    avgRenewalTimeMs,
    failedRenewals: failed.length,
  };
}

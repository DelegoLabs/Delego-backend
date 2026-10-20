import { createHash } from 'node:crypto';

export interface CefAuditExportSummaryInput {
  referenceId: string;
  eventCount: number;
  severityScore: number;
  droppedFieldCount: number;
  thresholdLimit?: number;
}

export interface CefAuditExportSummary {
  referenceId: string;
  eventCount: number;
  severityScore: number;
  droppedFieldCount: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function formatCefSecurityAuditBatch(input: CefAuditExportSummaryInput): CefAuditExportSummary {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('formatCefSecurityAuditBatch: referenceId is required');
  }
  if (
    !Number.isFinite(input.eventCount) ||
    !Number.isFinite(input.severityScore) ||
    !Number.isFinite(input.droppedFieldCount)
  ) {
    throw new Error('formatCefSecurityAuditBatch: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.eventCount));
  const v2 = Math.max(0, Math.trunc(input.severityScore));
  const v3 = Math.max(0, Math.trunc(input.droppedFieldCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (eventCount=${v1}, severityScore=${v2}, droppedFieldCount=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, droppedFieldCount=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    eventCount: v1,
    severityScore: v2,
    droppedFieldCount: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    eventCount: v1,
    severityScore: v2,
    droppedFieldCount: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}

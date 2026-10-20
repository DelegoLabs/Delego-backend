import { describe, expect, it } from 'vitest';
import { formatCefSecurityAuditBatch } from './cef-siem-audit-exporter.js';

describe('formatCefSecurityAuditBatch', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = formatCefSecurityAuditBatch({
      referenceId: 'ref-100',
      eventCount: 150,
      severityScore: 50,
      droppedFieldCount: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = formatCefSecurityAuditBatch({
      referenceId: 'ref-200',
      eventCount: 700,
      severityScore: 300,
      droppedFieldCount: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      formatCefSecurityAuditBatch({
        referenceId: '   ',
        eventCount: 1,
        severityScore: 2,
        droppedFieldCount: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});

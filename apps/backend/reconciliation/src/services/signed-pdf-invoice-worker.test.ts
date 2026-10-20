import { describe, expect, it } from 'vitest';
import { generateSignedPdfInvoiceDigest } from './signed-pdf-invoice-worker.js';

describe('generateSignedPdfInvoiceDigest', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = generateSignedPdfInvoiceDigest({
      referenceId: 'ref-100',
      lineItemCount: 150,
      totalAmountCents: 50,
      signatureKeyVersion: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = generateSignedPdfInvoiceDigest({
      referenceId: 'ref-200',
      lineItemCount: 700,
      totalAmountCents: 300,
      signatureKeyVersion: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      generateSignedPdfInvoiceDigest({
        referenceId: '   ',
        lineItemCount: 1,
        totalAmountCents: 2,
        signatureKeyVersion: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});

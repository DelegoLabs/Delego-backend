import { ReconciliationRecord } from "../models/ReconciliationRecord.js";
import { createLogger } from "@delegolabs/utils";
import { randomUUID } from "crypto";

const log = createLogger("reconciliation:matcher", process.env.LOG_LEVEL ?? "info");

/**
 * Matcher Service - Matches internal and external records
 */
export class MatcherService {
  /**
   * Match records for a reconciliation job
   */
  async matchRecords(
    jobId: string,
    internalRecords: Array<{
      id: string;
      amount: string;
      currency: string;
      date: string;
      reference: string;
      type: string;
      metadata?: Record<string, unknown>;
    }>,
    externalRecords: Array<{
      id?: string;
      amount: string;
      currency: string;
      date: string;
      reference: string;
      type: string;
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<{ matched: number; discrepancies: number; unmatchedInternal: number; unmatchedExternal: number }> {
    const matches: ReconciliationRecord[] = [];
    const unmatchedInternal: Array<{ id: string; amount: string; currency: string }> = [];
    const unmatchedExternal: Array<{ id?: string; amount: string; currency: string }> = [];

    // Create lookup maps
    const internalMap = new Map(internalRecords.map((r) => [this.createKey(r), r]));
    const externalMap = new Map(externalRecords.map((r) => [this.createKey(r), r]));

    // First pass: exact matches
    for (const internal of internalRecords) {
      const key = this.createKey(internal);
      const external = externalMap.get(key);

      if (external) {
        matches.push(this.createMatchRecord(jobId, internal, external));
        internalMap.delete(key);
        externalMap.delete(key);
      }
    }

    // Second pass: fuzzy matches (amount within threshold)
    for (const [key, internal] of internalMap.entries()) {
      const externalMatch = this.findBestExternalMatch(internal, Array.from(externalMap.values()));
      if (externalMatch) {
        matches.push(this.createMatchRecord(jobId, internal, externalMatch, true));
        internalMap.delete(key);
        externalMap.delete(this.createKey(externalMatch));
      } else {
        unmatchedInternal.push({ id: internal.id, amount: internal.amount, currency: internal.currency });
      }
    }

    // Remaining external records are unmatched
    for (const [key, external] of externalMap.entries()) {
      unmatchedExternal.push({ id: external.id, amount: external.amount, currency: external.currency });
    }

    // Save records to database
    await this.saveRecords(jobId, matches, unmatchedInternal, unmatchedExternal);

    const discrepancies = matches.filter((r) => r.status === "discrepancy").length;
    const matched = matches.filter((r) => r.status === "matched").length;

    return {
      matched,
      discrepancies,
      unmatchedInternal: unmatchedInternal.length,
      unmatchedExternal: unmatchedExternal.length,
    };
  }

  /**
   * Create a key for record matching
   */
  private createKey(record: {
    amount: string;
    currency: string;
    date: string;
    reference: string;
    type: string;
  }): string {
    return `${record.type}:${record.date}:${record.reference}:${record.currency}`;
  }

  /**
   * Find best external match for internal record
   */
  private findBestExternalMatch(
    internal: {
      amount: string;
      currency: string;
      date: string;
      reference: string;
      type: string;
    },
    externals: Array<{
      amount: string;
      currency: string;
      date: string;
      reference: string;
      type: string;
    }>,
  ): typeof externals[0] | undefined {
    let bestMatch: typeof externals[0] | undefined;
    let bestScore = 0;

    for (const external of externals) {
      const score = this.calculateMatchScore(internal, external);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = external;
      }
    }

    return bestScore >= 0.5 ? bestMatch : undefined;
  }

  /**
   * Calculate match score between records
   */
  private calculateMatchScore(internal: any, external: any): number {
    let score = 0;
    let weights = 0;

    // Amount match (weighted 40%)
    if (internal.currency === external.currency) {
      const amountDiff = Math.abs(parseFloat(internal.amount) - parseFloat(external.amount));
      const amountScore = amountDiff === 0 ? 1 : amountDiff / Math.max(parseFloat(internal.amount), parseFloat(external.amount));
      score += amountScore * 0.4;
      weights += 0.4;
    }

    // Date match (weighted 30%)
    if (internal.date === external.date) {
      score += 0.3;
      weights += 0.3;
    }

    // Reference match (weighted 20%)
    if (internal.reference === external.reference) {
      score += 0.2;
      weights += 0.2;
    }

    // Type match (weighted 10%)
    if (internal.type === external.type) {
      score += 0.1;
      weights += 0.1;
    }

    return weights > 0 ? score / weights : 0;
  }

  /**
   * Create match record
   */
  private createMatchRecord(
    jobId: string,
    internal: any,
    external: any,
    isFuzzyMatch: boolean = false,
  ): ReconciliationRecord {
    const internalAmount = parseFloat(internal.amount);
    const externalAmount = parseFloat(external.amount);
    const amountDiff = Math.abs(internalAmount - externalAmount);
    const isDiscrepancy = amountDiff > 0.01; // 1 cent tolerance

    return ReconciliationRecord.build({
      jobId,
      internalRecordId: internal.id,
      externalRecordId: external.id,
      status: isDiscrepancy ? "discrepancy" : "matched",
      internalAmount: internal.amount,
      externalAmount: external.amount,
      currency: internal.currency,
      discrepancyType: isDiscrepancy ? this.determineDiscrepancyType(internal, external) : undefined,
      discrepancyAmount: isDiscrepancy ? amountDiff.toString() : undefined,
    });
  }

  /**
   * Determine discrepancy type
   */
  private determineDiscrepancyType(internal: any, external: any): "amount" | "date" | "reference" | "fee" | "missing" {
    if (Math.abs(parseFloat(internal.amount) - parseFloat(external.amount)) > 0.01) {
      return "amount";
    }
    if (internal.date !== external.date) {
      return "date";
    }
    if (internal.reference !== external.reference) {
      return "reference";
    }
    if (internal.metadata?.fee && external.metadata?.fee) {
      return "fee";
    }
    return "missing";
  }

  /**
   * Save records to database
   */
  private async saveRecords(
    jobId: string,
    matches: ReconciliationRecord[],
    unmatchedInternal: Array<{ id: string; amount: string; currency: string }>,
    unmatchedExternal: Array<{ id?: string; amount: string; currency: string }>,
  ): Promise<void> {
    try {
      const recordsToSave: ReconciliationRecord[] = [...matches];

      for (const record of unmatchedInternal) {
        recordsToSave.push(
          ReconciliationRecord.build({
            jobId,
            internalRecordId: record.id,
            status: "unmatched_internal",
            internalAmount: record.amount,
            currency: record.currency,
          }),
        );
      }

      for (const record of unmatchedExternal) {
        recordsToSave.push(
          ReconciliationRecord.build({
            jobId,
            externalRecordId: record.id,
            status: "unmatched_external",
            internalAmount: "0",
            externalAmount: record.amount,
            currency: record.currency,
          }),
        );
      }

      if (recordsToSave.length > 0) {
        await ReconciliationRecord.bulkCreate(recordsToSave);
      }
    } catch (err) {
      log.error("Failed to save records", { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /**
   * Get records by job ID
   */
  async getRecordsByJob(jobId: string): Promise<ReconciliationRecord[]> {
    return ReconciliationRecord.findAll({ where: { job_id: jobId } });
  }

  /**
   * Get records by status
   */
  async getRecordsByStatus(status: string, limit: number = 100): Promise<ReconciliationRecord[]> {
    return ReconciliationRecord.findAll({ where: { status }, limit });
  }
}

export const matcherService = new MatcherService();

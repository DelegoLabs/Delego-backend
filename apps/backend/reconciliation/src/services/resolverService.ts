import { ReconciliationRecord } from "../models/ReconciliationRecord.js";
import { ReconciliationJob } from "../models/ReconciliationJob.js";
import { AuditLog } from "../models/AuditLog.js";
import { createLogger } from "@delegolabs/utils";
import { randomUUID } from "crypto";

const log = createLogger("reconciliation:resolver", process.env.LOG_LEVEL ?? "info");

/**
 * Resolver Service - Auto-resolves discrepancies and handles manual resolution
 */
export class ResolverService {
  /**
   * Auto-resolve discrepancies for known patterns
   */
  async autoResolveDiscrepancies(jobId?: string): Promise<{ resolved: number; patterns: Record<string, number> }> {
    const where: any = {
      status: "discrepancy",
      resolution: { [ReconciliationRecord.sequelize!.Op.is]: null },
    };

    if (jobId) where.job_id = jobId;

    const discrepancies = await ReconciliationRecord.findAll({ where });

    let resolvedCount = 0;
    const patterns: Record<string, number> = {};

    for (const record of discrepancies) {
      const resolution = await this.autoResolvePattern(record);
      if (resolution) {
        await this.resolveRecord(record, resolution.type, "system", resolution.notes);
        patterns[resolution.type] = (patterns[resolution.type] || 0) + 1;
        resolvedCount++;
      }
    }

    return { resolved: resolvedCount, patterns };
  }

  /**
   * Auto-resolve based on known patterns
   */
  private async autoResolvePattern(record: ReconciliationRecord): Promise<{ type: string; notes: string } | null> {
    // Pattern 1: Small amount difference (< $0.01) - rounding
    if (record.discrepancyAmount && parseFloat(record.discrepancyAmount) < 0.01) {
      return {
        type: "auto_resolved",
        notes: "Amount difference is within rounding tolerance",
      };
    }

    // Pattern 2: Date difference within 1 day - timing
    if (record.discrepancyType === "date") {
      return {
        type: "auto_resolved",
        notes: "Date difference within acceptable timing window",
      };
    }

    // Pattern 3: Fee discrepancy - often acceptable variance
    if (record.discrepancyType === "fee") {
      return {
        type: "auto_resolved",
        notes: "Fee variance within acceptable range",
      };
    }

    // Pattern 4: Reference mismatch - often duplicate processing
    if (record.discrepancyType === "reference") {
      return {
        type: "auto_resolved",
        notes: "Reference mismatch likely due to duplicate processing",
      };
    }

    return null;
  }

  /**
   * Resolve discrepancy manually
   */
  async resolveDiscrepancy(
    recordId: string,
    resolution: "auto_resolved" | "manual_resolved" | "investigating" | "write_off",
    notes?: string,
    resolvedBy?: string,
  ): Promise<ReconciliationRecord | null> {
    const record = await ReconciliationRecord.findByPk(recordId);
    if (!record) return null;

    await this.resolveRecord(record, resolution, resolvedBy || "unknown", notes);

    return record;
  }

  /**
   * Resolve a discrepancy record
   */
  private async resolveRecord(
    record: ReconciliationRecord,
    resolution: string,
    resolvedBy: string,
    notes?: string,
  ): Promise<void> {
    const oldResolution = record.resolution;

    await record.update({
      resolution,
      resolvedAt: new Date(),
      resolvedBy,
    });

    // Update parent job discrepancy count
    const job = await ReconciliationJob.findByPk(record.job_id);
    if (job && resolution !== "investigating") {
      const discrepancies = Math.max(0, job.discrepancies - 1);
      await job.update({ discrepancies });
    }

    // Log audit
    await AuditLog.create({
      recordId: record.id,
      action: "discrepancy_resolved",
      details: {
        oldResolution,
        newResolution: resolution,
        resolvedBy,
        notes,
        discrepancyType: record.discrepancyType,
        discrepancyAmount: record.discrepancyAmount,
      },
      timestamp: new Date(),
    });
  }

  /**
   * Write off discrepancy
   */
  async writeOffDiscrepancy(recordId: string, reason: string, resolvedBy: string): Promise<ReconciliationRecord | null> {
    return this.resolveDiscrepancy(recordId, "write_off", reason, resolvedBy);
  }

  /**
   * Get records for manual resolution
   */
  async getRecordsForResolution(params?: {
    status?: string;
    type?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ records: ReconciliationRecord[]; total: number }> {
    const where: any = {
      status: "discrepancy",
      resolution: { [ReconciliationRecord.sequelize!.Op.is]: null },
    };

    if (params?.type) where.discrepancy_type = params.type;

    const page = params?.page || 1;
    const pageSize = params?.pageSize || 50;
    const offset = (page - 1) * pageSize;

    const records = await ReconciliationRecord.findAll({
      where,
      limit: pageSize,
      offset,
    });

    const total = await ReconciliationRecord.count({ where });

    return { records, total };
  }

  /**
   * Get auto-resolution statistics
   */
  async getAutoResolutionStats(): Promise<{
    totalDiscrepancies: number;
    autoResolved: number;
    autoResolutionRate: number;
  }> {
    const totalDiscrepancies = await ReconciliationRecord.count({
      where: { status: "discrepancy" },
    });

    const autoResolved = await ReconciliationRecord.count({
      where: { status: "discrepancy", resolution: { [ReconciliationRecord.sequelize!.Op.ne]: null } },
    });

    return {
      totalDiscrepancies,
      autoResolved,
      autoResolutionRate: totalDiscrepancies > 0 ? autoResolved / totalDiscrepancies : 0,
    };
  }

  /**
   * Get pattern resolution statistics
   */
  async getPatternStats(): Promise<Record<string, { count: number; totalAmount: number }>> {
    const records = await ReconciliationRecord.findAll({
      where: {
        status: "discrepancy",
        resolution: { [ReconciliationRecord.sequelize!.Op.ne]: null },
      },
    });

    const patterns: Record<string, { count: number; totalAmount: number }> = {};

    for (const record of records) {
      const key = record.discrepancyType || "unknown";
      if (!patterns[key]) {
        patterns[key] = { count: 0, totalAmount: 0 };
      }
      patterns[key].count++;
      if (record.discrepancyAmount) {
        patterns[key].totalAmount += parseFloat(record.discrepancyAmount);
      }
    }

    return patterns;
  }
}

export const resolverService = new ResolverService();

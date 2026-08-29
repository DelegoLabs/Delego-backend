import { ReconciliationRecord } from "../models/ReconciliationRecord.js";
import { ReconciliationReport } from "../models/ReconciliationReport.js";
import { ReconciliationJob } from "../models/ReconciliationJob.js";
import { exchangeRateService } from "./exchangeRateService.js";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("reconciliation:reporting", process.env.LOG_LEVEL ?? "info");

/**
 * Reporting Service - Generates reconciliation reports
 */
export class ReportingService {
  /**
   * Get reconciliation report for a job
   */
  async getReport(jobId: string): Promise<ReconciliationReport | null> {
    return ReconciliationReport.findOne({ where: { job_id: jobId } });
  }

  /**
   * Get summary report
   */
  async getSummary(): Promise<{
    totalJobs: number;
    completedJobs: number;
    pendingJobs: number;
    failedJobs: number;
    totalMatched: number;
    totalDiscrepancies: number;
    averageMatchRate: number;
    lastRun: string;
  }> {
    const jobs = await ReconciliationJob.findAll();

    const completedJobs = jobs.filter((j) => j.status === "completed" || j.status === "partial");
    const pendingJobs = jobs.filter((j) => j.status === "pending");
    const failedJobs = jobs.filter((j) => j.status === "failed");

    const totalMatched = jobs.reduce((sum, j) => sum + j.matchedRecords, 0);
    const totalDiscrepancies = jobs.reduce((sum, j) => sum + j.discrepancies, 0);
    const totalRecords = jobs.reduce((sum, j) => sum + j.totalRecords, 0);

    const lastRun = jobs[0]?.started_at?.toISOString() || new Date().toISOString();

    return {
      totalJobs: jobs.length,
      completedJobs: completedJobs.length,
      pendingJobs: pendingJobs.length,
      failedJobs: failedJobs.length,
      totalMatched,
      totalDiscrepancies,
      averageMatchRate: totalRecords > 0 ? totalMatched / totalRecords : 0,
      lastRun,
    };
  }

  /**
   * Get reconciliation records with report data
   */
  async getRecordsWithReport(jobId: string): Promise<{
    records: ReconciliationRecord[];
    report: ReconciliationReport | null;
  }> {
    const [records, report] = await Promise.all([
      ReconciliationRecord.findAll({ where: { job_id: jobId } }),
      this.getReport(jobId),
    ]);

    return { records, report };
  }

  /**
   * Get unresolved discrepancies with details
   */
  async getUnresolvedDiscrepancies(params?: {
    page?: number;
    pageSize?: number;
  }): Promise<{
    discrepancies: Array<{
      record: ReconciliationRecord;
      job: ReconciliationJob;
    }>;
    total: number;
  }> {
    const page = params?.page || 1;
    const pageSize = params?.pageSize || 50;
    const offset = (page - 1) * pageSize;

    const records = await ReconciliationRecord.findAll({
      where: {
        status: "discrepancy",
        resolution: { [ReconciliationRecord.sequelize!.Op.is]: null },
      },
      limit: pageSize,
      offset,
      include: [{ model: ReconciliationJob }],
    });

    const total = await ReconciliationRecord.count({
      where: {
        status: "discrepancy",
        resolution: { [ReconciliationRecord.sequelize!.Op.is]: null },
      },
    });

    return {
      discrepancies: records as any,
      total,
    };
  }

  /**
   * Get discrepancies by type
   */
  async getDiscrepanciesByType(): Promise<Array<{ type: string; count: number; totalAmount: string }>> {
    const records = await ReconciliationRecord.findAll({
      where: {
        status: "discrepancy",
      },
    });

    const byType: Record<string, { count: number; totalAmount: number }> = {};

    for (const record of records) {
      const type = record.discrepancyType || "unknown";
      if (!byType[type]) {
        byType[type] = { count: 0, totalAmount: 0 };
      }
      byType[type].count++;
      if (record.discrepancyAmount) {
        byType[type].totalAmount += parseFloat(record.discrepancyAmount);
      }
    }

    return Object.entries(byType)
      .map(([type, data]) => ({
        type,
        count: data.count,
        totalAmount: data.totalAmount.toFixed(2),
      }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Get currency breakdown
   */
  async getCurrencyBreakdown(jobId?: string): Promise<Record<string, { count: number; amount: string }>> {
    const where: any = {};
    if (jobId) where.job_id = jobId;

    const records = await ReconciliationRecord.findAll({
      where,
      attributes: ["currency", "internalAmount", "status"],
    });

    const byCurrency: Record<string, { count: number; amount: number }> = {};

    for (const record of records) {
      const currency = record.currency;
      if (!byCurrency[currency]) {
        byCurrency[currency] = { count: 0, amount: 0 };
      }
      byCurrency[currency].count++;
      byCurrency[currency].amount += parseFloat(record.internalAmount);
    }

    return Object.entries(byCurrency).reduce((acc, [currency, data]) => ({
      ...acc,
      [currency]: {
        count: data.count,
        amount: data.amount.toFixed(2),
      },
    }), {});
  }

  /**
   * Get top discrepancies for audit
   */
  async getTopDiscrepancies(limit: number = 10): Promise<Array<{
    type: string;
    count: number;
    totalAmount: string;
    jobs: string[];
  }>> {
    const records = await ReconciliationRecord.findAll({
      where: {
        status: "discrepancy",
      },
      attributes: ["discrepancyType", "job_id", "discrepancyAmount"],
    });

    const byType: Record<string, { count: number; totalAmount: number; jobs: Set<string> }> = {};

    for (const record of records) {
      const type = record.discrepancyType || "unknown";
      if (!byType[type]) {
        byType[type] = { count: 0, totalAmount: 0, jobs: new Set() };
      }
      byType[type].count++;
      if (record.discrepancyAmount) {
        byType[type].totalAmount += parseFloat(record.discrepancyAmount);
      }
      byType[type].jobs.add(record.job_id);
    }

    return Object.entries(byType)
      .map(([type, data]) => ({
        type,
        count: data.count,
        totalAmount: data.totalAmount.toFixed(2),
        jobs: Array.from(data.jobs),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /**
   * Generate audit report
   */
  async generateAuditReport(startDate: string, endDate: string): Promise<{
    jobs: ReconciliationJob[];
    records: ReconciliationRecord[];
    discrepancies: number;
    matchRate: number;
  }> {
    const jobs = await ReconciliationJob.findAll({
      where: {
        started_at: {
          [ReconciliationJob.sequelize!.Op.gte]: new Date(startDate),
          [ReconciliationJob.sequelize!.Op.lte]: new Date(endDate),
        },
      },
    });

    const recordIds = jobs.map((j) => j.id);
    const records = await ReconciliationRecord.findAll({
      where: { job_id: recordIds },
    });

    const discrepancies = records.filter((r) => r.status === "discrepancy").length;
    const matched = records.filter((r) => r.status === "matched").length;

    return {
      jobs,
      records,
      discrepancies,
      matchRate: records.length > 0 ? matched / records.length : 0,
    };
  }
}

export const reportingService = new ReportingService();

import { FraudCase } from "../models/FraudCase.js";
import { FraudCheckResult } from "../models/FraudCheckResult.js";
import { FraudEventLog } from "../models/FraudEventLog.js";
import { CreateFraudCaseRequest, UpdateFraudCaseRequest, AddEvidenceRequest, FraudCaseResponse } from "../schemas.js";
import { randomUUID } from "crypto";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("fraud-detection:cases", process.env.LOG_LEVEL ?? "info");

/**
 * Case Management Service
 */
export class CaseManagementService {
  /**
   * Create a new fraud case
   */
  async createCase(request: CreateFraudCaseRequest): Promise<FraudCaseResponse> {
    const caseData = await FraudCase.create({
      transactionId: request.transactionId,
      status: "open",
      priority: request.priority || "medium",
      assignedTo: request.assignedTo,
    });

    // Add initial evidence from fraud check result
    await this.addEvidence(caseData.id, {
      type: "fraud_check_result",
      data: await this.getFraudCheckData(request.transactionId),
      addedAt: new Date().toISOString(),
      addedBy: "system",
    });

    return this.formatCase(caseData);
  }

  /**
   * Get case by ID
   */
  async getCase(id: string): Promise<FraudCaseResponse | null> {
    const caseData = await FraudCase.findByPk(id);
    if (!caseData) return null;

    return this.formatCase(caseData);
  }

  /**
   * List cases
   */
  async listCases(params?: {
    status?: "open" | "investigating" | "confirmed_fraud" | "false_positive" | "closed";
    priority?: "low" | "medium" | "high" | "urgent";
    assignedTo?: string;
    limit?: number;
    offset?: number;
  }): Promise<FraudCaseResponse[]> {
    const where: any = {};
    if (params?.status) where.status = params.status;
    if (params?.priority) where.priority = params.priority;
    if (params?.assignedTo) where.assigned_to = params.assignedTo;

    const cases = await FraudCase.findAll({
      where,
      limit: params?.limit || 50,
      offset: params?.offset || 0,
      order: [["created_at", "DESC"]],
    });

    return cases.map((c) => this.formatCase(c));
  }

  /**
   * Update case status
   */
  async updateCase(id: string, updates: UpdateFraudCaseRequest): Promise<FraudCaseResponse | null> {
    const caseData = await FraudCase.findByPk(id);
    if (!caseData) return null;

    await caseData.update(updates);

    // Log status change
    await this.logStatusChange(id, caseData.status, updates.status || "unknown");

    return this.formatCase(caseData);
  }

  /**
   * Close case with resolution
   */
  async closeCase(id: string, outcome: "fraud" | "legitimate", actionTaken: string, resolvedBy: string): Promise<FraudCaseResponse | null> {
    const caseData = await FraudCase.findByPk(id);
    if (!caseData) return null;

    const updateData: Partial<FraudCase> = {
      status: outcome === "fraud" ? "confirmed_fraud" : "false_positive",
      resolution: {
        outcome,
        actionTaken,
        resolvedAt: new Date().toISOString(),
        resolvedBy,
      },
    };

    await caseData.update(updateData);

    return this.formatCase(caseData);
  }

  /**
   * Add evidence to case
   */
  async addEvidence(caseId: string, evidence: AddEvidenceRequest): Promise<FraudCaseResponse | null> {
    const caseData = await FraudCase.findByPk(caseId);
    if (!caseData) return null;

    const updatedEvidence = [...caseData.evidence, {
      ...evidence,
      addedAt: new Date().toISOString(),
    }];

    await caseData.update({ evidence: updatedEvidence });

    return this.formatCase(caseData);
  }

  /**
   * Assign case to analyst
   */
  async assignCase(caseId: string, analystId: string): Promise<FraudCaseResponse | null> {
    return this.updateCase(caseId, { assignedTo: analystId });
  }

  /**
   * Change case priority
   */
  async changePriority(caseId: string, priority: "low" | "medium" | "high" | "urgent"): Promise<FraudCaseResponse | null> {
    return this.updateCase(caseId, { priority });
  }

  /**
   * Get case history
   */
  async getCaseHistory(caseId: string): Promise<FraudEventLog[]> {
    const caseData = await FraudCase.findByPk(caseId);
    if (!caseData) return [];

    return FraudEventLog.findAll({
      where: {
        transaction_id: caseData.transactionId,
      },
      order: [["created_at", "DESC"]],
    });
  }

  /**
   * Get fraud check data for a transaction
   */
  private async getFraudCheckData(transactionId: string): Promise<Record<string, unknown> | null> {
    const result = await FraudCheckResult.findOne({ where: { transaction_id: transactionId } });
    return result ? result.toJSON() : null;
  }

  /**
   * Format case for response
   */
  private formatCase(caseData: FraudCase): FraudCaseResponse {
    return {
      id: caseData.id,
      transactionId: caseData.transactionId,
      status: caseData.status as any,
      assignedTo: caseData.assignedTo || undefined,
      priority: caseData.priority as any,
      evidence: caseData.evidence,
      resolution: caseData.resolution as any,
      createdAt: caseData.created_at?.toISOString() || new Date().toISOString(),
      updatedAt: caseData.updated_at?.toISOString() || new Date().toISOString(),
    };
  }

  /**
   * Log status change
   */
  private async logStatusChange(caseId: string, oldStatus: string, newStatus: string): Promise<void> {
    try {
      await FraudEventLog.create({
        eventId: randomUUID(),
        eventType: "case_status_changed",
        details: {
          caseId,
          oldStatus,
          newStatus,
        },
        severity: "info",
      });
    } catch (err) {
      log.warn("Failed to log status change", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Get cases by status
   */
  async getCasesByStatus(status: "open" | "investigating" | "confirmed_fraud" | "false_positive" | "closed"): Promise<FraudCaseResponse[]> {
    return this.listCases({ status });
  }

  /**
   * Get cases by analyst
   */
  async getCasesByAnalyst(analystId: string): Promise<FraudCaseResponse[]> {
    return this.listCases({ assignedTo: analystId });
  }

  /**
   * Get pending cases count
   */
  async getPendingCasesCount(): Promise<number> {
    const cases = await FraudCase.findAll({
      where: {
        status: { [FraudCase.sequelize!.Op.in]: ["open", "investigating"] },
      },
    });
    return cases.length;
  }
}

export const caseManagementService = new CaseManagementService();

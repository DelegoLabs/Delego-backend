import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

export interface ReconciliationReportAttributes {
  id: string;
  jobId: string;
  reportData: {
    summary: {
      total: number;
      matched: number;
      discrepancies: number;
      unresolved: number;
      matchRate: number;
    };
    byType: Record<string, { count: number; amount: string }>;
    byCurrency: Record<string, { count: number; amount: string }>;
    topDiscrepancies: Array<{
      type: string;
      count: number;
      totalAmount: string;
    }>;
  };
  generatedAt: Date;
  createdAt?: Date;
}

export type ReconciliationReportCreationAttributes = Optional<ReconciliationReportAttributes, "id" | "createdAt">;

export class ReconciliationReport extends Model<ReconciliationReportAttributes, ReconciliationReportCreationAttributes> {
  public id!: string;
  public jobId!: string;
  public reportData!: {
    summary: {
      total: number;
      matched: number;
      discrepancies: number;
      unresolved: number;
      matchRate: number;
    };
    byType: Record<string, { count: number; amount: string }>;
    byCurrency: Record<string, { count: number; amount: string }>;
    topDiscrepancies: Array<{
      type: string;
      count: number;
      totalAmount: string;
    }>;
  };
  public generatedAt!: Date;
}

ReconciliationReport.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    jobId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "job_id",
      references: {
        model: "reconciliation_jobs",
        key: "id",
      },
    },
    reportData: {
      type: DataTypes.JSONB,
      allowNull: false,
    },
    generatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    modelName: "ReconciliationReport",
    tableName: "reconciliation_reports",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["job_id"], unique: true },
      { fields: ["generated_at"] },
    ],
  }
);

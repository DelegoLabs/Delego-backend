import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

export interface ReconciliationRecordAttributes {
  id: string;
  jobId: string;
  internalRecordId: string;
  externalRecordId?: string;
  status: "matched" | "unmatched_internal" | "unmatched_external" | "discrepancy";
  internalAmount: string;
  externalAmount?: string;
  currency: string;
  discrepancyType?: "amount" | "date" | "reference" | "fee" | "missing";
  discrepancyAmount?: string;
  resolution?: "auto_resolved" | "manual_resolved" | "investigating" | "write_off";
  resolvedAt?: Date;
  resolvedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type ReconciliationRecordCreationAttributes = Optional<ReconciliationRecordAttributes, "id" | "createdAt" | "updatedAt">;

export class ReconciliationRecord extends Model<ReconciliationRecordAttributes, ReconciliationRecordCreationAttributes> {
  public id!: string;
  public jobId!: string;
  public internalRecordId!: string;
  public externalRecordId?: string;
  public status!: string;
  public internalAmount!: string;
  public externalAmount?: string;
  public currency!: string;
  public discrepancyType?: string;
  public discrepancyAmount?: string;
  public resolution?: string;
  public resolvedAt?: Date;
  public resolvedBy?: string;
}

ReconciliationRecord.init(
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
    internalRecordId: {
      type: DataTypes.STRING(100),
      allowNull: false,
      field: "internal_record_id",
    },
    externalRecordId: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: "external_record_id",
    },
    status: {
      type: DataTypes.ENUM("matched", "unmatched_internal", "unmatched_external", "discrepancy"),
      allowNull: false,
    },
    internalAmount: {
      type: DataTypes.DECIMAL(18, 4),
      allowNull: false,
    },
    externalAmount: {
      type: DataTypes.DECIMAL(18, 4),
      allowNull: true,
    },
    currency: {
      type: DataTypes.STRING(3),
      allowNull: false,
    },
    discrepancyType: {
      type: DataTypes.ENUM("amount", "date", "reference", "fee", "missing"),
      allowNull: true,
    },
    discrepancyAmount: {
      type: DataTypes.DECIMAL(18, 4),
      allowNull: true,
    },
    resolution: {
      type: DataTypes.ENUM("auto_resolved", "manual_resolved", "investigating", "write_off"),
      allowNull: true,
    },
    resolvedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    resolvedBy: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "ReconciliationRecord",
    tableName: "reconciliation_records",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["job_id"] },
      { fields: ["internal_record_id"] },
      { fields: ["external_record_id"] },
      { fields: ["status"] },
      { fields: ["currency"] },
    ],
  }
);

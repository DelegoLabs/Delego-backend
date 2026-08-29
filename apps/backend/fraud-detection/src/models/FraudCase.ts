import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

export interface FraudCaseAttributes {
  id: string;
  transactionId: string;
  status: "open" | "investigating" | "confirmed_fraud" | "false_positive" | "closed";
  assignedTo?: string;
  priority: "low" | "medium" | "high" | "urgent";
  evidence: Array<{
    type: string;
    data: Record<string, unknown>;
    addedAt: string;
    addedBy: string;
  }>;
  resolution?: {
    outcome: "fraud" | "legitimate";
    actionTaken: string;
    resolvedAt: string;
    resolvedBy: string;
  };
  createdAt?: Date;
  updatedAt?: Date;
}

export type FraudCaseCreationAttributes = Optional<FraudCaseAttributes, "id" | "createdAt" | "updatedAt">;

export class FraudCase extends Model<FraudCaseAttributes, FraudCaseCreationAttributes> {
  public id!: string;
  public transactionId!: string;
  public status!: string;
  public assignedTo?: string;
  public priority!: string;
  public evidence!: Array<{
    type: string;
    data: Record<string, unknown>;
    addedAt: string;
    addedBy: string;
  }>;
  public resolution?: {
    outcome: "fraud" | "legitimate";
    actionTaken: string;
    resolvedAt: string;
    resolvedBy: string;
  };
}

FraudCase.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    transactionId: {
      type: DataTypes.STRING(100),
      allowNull: false,
      field: "transaction_id",
    },
    status: {
      type: DataTypes.ENUM("open", "investigating", "confirmed_fraud", "false_positive", "closed"),
      defaultValue: "open",
    },
    assignedTo: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: "assigned_to",
    },
    priority: {
      type: DataTypes.ENUM("low", "medium", "high", "urgent"),
      defaultValue: "medium",
    },
    evidence: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    resolution: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "FraudCase",
    tableName: "fraud_cases",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["transaction_id"], unique: true },
      { fields: ["status"] },
      { fields: ["priority"] },
      { fields: ["assigned_to"] },
    ],
  }
);

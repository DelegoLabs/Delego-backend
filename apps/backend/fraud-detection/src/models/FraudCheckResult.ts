import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

export interface FraudCheckResultAttributes {
  id: string;
  transactionId: string;
  score: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  factors: Array<{
    name: string;
    value: unknown;
    weight: number;
    contribution: number;
  }>;
  rulesTriggered: string[];
  recommendation: "approve" | "review" | "decline";
  modelVersion: string;
  scoredAt: Date;
  createdAt?: Date;
}

export type FraudCheckResultCreationAttributes = Optional<FraudCheckResultAttributes, "id" | "createdAt">;

export class FraudCheckResult extends Model<FraudCheckResultAttributes, FraudCheckResultCreationAttributes> {
  public id!: string;
  public transactionId!: string;
  public score!: number;
  public riskLevel!: string;
  public factors!: Array<{
    name: string;
    value: unknown;
    weight: number;
    contribution: number;
  }>;
  public rulesTriggered!: string[];
  public recommendation!: string;
  public modelVersion!: string;
  public scoredAt!: Date;
}

FraudCheckResult.init(
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
      unique: true,
    },
    score: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    riskLevel: {
      type: DataTypes.ENUM("low", "medium", "high", "critical"),
      allowNull: false,
    },
    factors: {
      type: DataTypes.JSONB,
      allowNull: false,
    },
    rulesTriggered: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    recommendation: {
      type: DataTypes.ENUM("approve", "review", "decline"),
      allowNull: false,
    },
    modelVersion: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    scoredAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    modelName: "FraudCheckResult",
    tableName: "fraud_check_results",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["transaction_id"], unique: true },
      { fields: ["score"] },
      { fields: ["risk_level"] },
      { fields: ["scored_at"] },
    ],
  }
);

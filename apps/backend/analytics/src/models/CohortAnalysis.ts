import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

export interface CohortAnalysisAttributes {
  id: string;
  cohort: string; // Format: YYYY-MM or YYYY-WW
  period: number; // Weeks since cohort
  size: number;
  retained: number;
  engagementRate: number;
  revenuePerUser: number;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

export type CohortAnalysisCreationAttributes = Optional<CohortAnalysisAttributes, "id" | "createdAt" | "updatedAt">;

export class CohortAnalysis extends Model<CohortAnalysisAttributes, CohortAnalysisCreationAttributes> {
  public id!: string;
  public cohort!: string;
  public period!: number;
  public size!: number;
  public retained!: number;
  public engagementRate!: number;
  public revenuePerUser!: number;
  public metadata?: Record<string, unknown>;
}

CohortAnalysis.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    cohort: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    period: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    size: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    retained: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    engagementRate: {
      type: DataTypes.DECIMAL(5, 4),
      allowNull: false,
      defaultValue: 0,
    },
    revenuePerUser: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "CohortAnalysis",
    tableName: "cohort_analyses",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["cohort"] },
      { fields: ["cohort", "period"], unique: true },
    ],
  }
);

import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

export interface ReconciliationJobAttributes {
  id: string;
  type: "daily" | "intraday" | "monthly" | "on_demand";
  status: "pending" | "running" | "completed" | "failed" | "partial";
  startDate: string;
  endDate: string;
  accounts: string[];
  totalRecords: number;
  matchedRecords: number;
  discrepancies: number;
  startedAt: Date;
  completedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export type ReconciliationJobCreationAttributes = Optional<ReconciliationJobAttributes, "id" | "createdAt" | "updatedAt">;

export class ReconciliationJob extends Model<ReconciliationJobAttributes, ReconciliationJobCreationAttributes> {
  public id!: string;
  public type!: string;
  public status!: string;
  public startDate!: string;
  public endDate!: string;
  public accounts!: string[];
  public totalRecords!: number;
  public matchedRecords!: number;
  public discrepancies!: number;
  public startedAt!: Date;
  public completedAt?: Date;
}

ReconciliationJob.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    type: {
      type: DataTypes.ENUM("daily", "intraday", "monthly", "on_demand"),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM("pending", "running", "completed", "failed", "partial"),
      defaultValue: "pending",
    },
    startDate: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    endDate: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    accounts: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    totalRecords: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    matchedRecords: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    discrepancies: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    startedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "ReconciliationJob",
    tableName: "reconciliation_jobs",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["type"] },
      { fields: ["status"] },
      { fields: ["started_at"] },
    ],
  }
);

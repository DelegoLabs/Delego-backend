import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

export interface DataExportLogAttributes {
  id: string;
  exportType: "funnel" | "engagement" | "cohorts" | "ab-tests" | "custom";
  format: "csv" | "json" | "parquet";
  status: "pending" | "processing" | "completed" | "failed";
  destination: string; // S3 path, warehouse table name, etc.
  fileKey?: string;
  rowCount?: number;
  sizeBytes?: number;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
  completedAt?: Date;
}

export type DataExportLogCreationAttributes = Optional<DataExportLogAttributes, "id" | "createdAt" | "updatedAt">;

export class DataExportLog extends Model<DataExportLogAttributes, DataExportLogCreationAttributes> {
  public id!: string;
  public exportType!: string;
  public format!: string;
  public status!: string;
  public destination!: string;
  public fileKey?: string;
  public rowCount?: number;
  public sizeBytes?: number;
  public error?: string;
  public metadata?: Record<string, unknown>;
}

DataExportLog.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    exportType: {
      type: DataTypes.ENUM("funnel", "engagement", "cohorts", "ab-tests", "custom"),
      allowNull: false,
    },
    format: {
      type: DataTypes.ENUM("csv", "json", "parquet"),
      defaultValue: "csv",
    },
    status: {
      type: DataTypes.ENUM("pending", "processing", "completed", "failed"),
      defaultValue: "pending",
    },
    destination: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    fileKey: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    rowCount: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    sizeBytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
    error: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "completed_at",
    },
  },
  {
    sequelize,
    modelName: "DataExportLog",
    tableName: "data_export_logs",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["export_type"] },
      { fields: ["status"] },
      { fields: ["created_at"] },
    ],
  }
);

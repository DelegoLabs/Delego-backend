import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

export interface AuditLogAttributes {
  id: string;
  jobId?: string;
  recordId?: string;
  action: string;
  details: Record<string, unknown>;
  userId?: string;
  timestamp: Date;
  createdAt?: Date;
}

export type AuditLogCreationAttributes = Optional<AuditLogAttributes, "id" | "createdAt">;

export class AuditLog extends Model<AuditLogAttributes, AuditLogCreationAttributes> {
  public id!: string;
  public jobId?: string;
  public recordId?: string;
  public action!: string;
  public details!: Record<string, unknown>;
  public userId?: string;
  public timestamp!: Date;
}

AuditLog.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    jobId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "job_id",
    },
    recordId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "record_id",
    },
    action: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    details: {
      type: DataTypes.JSONB,
      allowNull: false,
    },
    userId: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    timestamp: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    modelName: "AuditLog",
    tableName: "audit_logs",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["job_id"] },
      { fields: ["record_id"] },
      { fields: ["action"] },
      { fields: ["timestamp"] },
    ],
  }
);

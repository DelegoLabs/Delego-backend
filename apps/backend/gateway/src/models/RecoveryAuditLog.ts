import { Model, DataTypes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * Recovery audit log model
 * Immutable logging for all recovery actions
 */
export class RecoveryAuditLog extends Model {
  public id!: string;
  public requestId!: string;
  public action!: "initiated" | "guardian_approved" | "guardian_rejected" | "delay_expired" | "completed" | "cancelled";
  public actor!: string; // user ID, guardian ID, or system
  public timestamp!: Date;
  public details!: Record<string, unknown>;
  public ipAddress?: string;
  public userAgent?: string;
}

RecoveryAuditLog.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    requestId: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: "Recovery request ID this log entry belongs to",
    },
    action: {
      type: DataTypes.ENUM("initiated", "guardian_approved", "guardian_rejected", "delay_expired", "completed", "cancelled"),
      allowNull: false,
      comment: "Action that was performed",
    },
    actor: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: "User ID or guardian ID who performed the action",
    },
    timestamp: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: "When the action occurred",
    },
    details: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
      comment: "Additional details about the action",
    },
    ipAddress: {
      type: DataTypes.STRING(45),
      allowNull: true,
      comment: "IP address of the actor (IPv4 or IPv6)",
    },
    userAgent: {
      type: DataTypes.STRING(512),
      allowNull: true,
      comment: "User agent string of the actor",
    },
  },
  {
    sequelize,
    modelName: "RecoveryAuditLog",
    tableName: "recovery_audit_logs",
    timestamps: false,
    underscored: false,
    indexes: [
      {
        fields: ["request_id"],
      },
      {
        fields: ["action"],
      },
      {
        fields: ["timestamp"],
      },
      {
        fields: ["actor"],
      },
    ],
    comment: "Immutable audit log for recovery actions",
  }
);

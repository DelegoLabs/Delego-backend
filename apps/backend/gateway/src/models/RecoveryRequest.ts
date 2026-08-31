import { Model, DataTypes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * Recovery request model
 * Tracks individual recovery attempts with guardian approvals
 */
export class RecoveryRequest extends Model {
  public id!: string;
  public accountId!: string;
  public initiatedBy!: string; // user or guardian ID
  public type!: "social" | "emergency" | "hardware";
  public status!: "pending" | "verifying" | "delayed" | "approved" | "completed" | "cancelled";
  public guardiansApproved!: string[];
  public guardiansRejected!: string[];
  public delayEndsAt?: string; // When the time delay expires
  public initiatedAt!: string;
  public expiresAt!: string;
  public completedAt?: string;
  public cancelledAt?: string;
  public newCredentials?: {
    publicKey: string;
    recoveryPhrase?: string;
    newStellarAddress?: string;
  };
  public metadata!: Record<string, unknown>;
}

RecoveryRequest.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    accountId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: "users",
        key: "id",
      },
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
    },
    initiatedBy: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: "User ID or guardian ID who initiated the recovery",
    },
    type: {
      type: DataTypes.ENUM("social", "emergency", "hardware"),
      allowNull: false,
      comment: "Type of recovery requested",
    },
    status: {
      type: DataTypes.ENUM("pending", "verifying", "delayed", "approved", "completed", "cancelled"),
      allowNull: false,
      defaultValue: "pending",
      comment: "Current status of the recovery request",
    },
    guardiansApproved: {
      type: DataTypes.ARRAY(DataTypes.UUID),
      allowNull: false,
      defaultValue: [],
      comment: "Array of guardian IDs who have approved this recovery",
    },
    guardiansRejected: {
      type: DataTypes.ARRAY(DataTypes.UUID),
      allowNull: false,
      defaultValue: [],
      comment: "Array of guardian IDs who have rejected this recovery",
    },
    delayEndsAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "When the recovery delay expires (can proceed to complete)",
    },
    initiatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: "When the recovery was initiated",
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: "When the recovery request expires (must be completed before this)",
    },
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "When the recovery was completed",
    },
    cancelledAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "When the recovery was cancelled",
    },
    newCredentials: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: null,
      comment: "New credentials after successful recovery",
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
      comment: "Additional metadata for the recovery request",
    },
  },
  {
    sequelize,
    modelName: "RecoveryRequest",
    tableName: "recovery_requests",
    timestamps: false,
    underscored: false,
    indexes: [
      {
        fields: ["account_id"],
      },
      {
        fields: ["status"],
      },
      {
        fields: ["initiated_at"],
      },
      {
        fields: ["expires_at"],
      },
      {
        fields: ["delay_ends_at"],
      },
    ],
    comment: "Individual recovery requests with guardian approval tracking",
  }
);

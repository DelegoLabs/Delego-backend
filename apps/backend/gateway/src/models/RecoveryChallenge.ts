import { Model, DataTypes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * Recovery challenge model
 * Tracks verification challenges for guardians and emergency contacts
 */
export class RecoveryChallenge extends Model {
  public id!: string;
  public requestId!: string;
  public guardianId?: string;
  public contactId?: string;
  public method!: "email" | "phone" | "wallet_signature" | "hardware_signature";
  public challengeId!: string;
  public codeHash?: string; // Hash of verification code for email/phone
  public expiresAt!: string;
  public attempts!: number;
  public maxAttempts!: number;
  public verifiedAt?: string;
  public rejectedAt?: string;
  public completedAt?: string;
}

RecoveryChallenge.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    requestId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: "recovery_requests",
        key: "id",
      },
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
    },
    guardianId: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: "Guardian ID if this challenge is for a guardian",
    },
    contactId: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: "Contact ID if this challenge is for an emergency contact",
    },
    method: {
      type: DataTypes.ENUM("email", "phone", "wallet_signature", "hardware_signature"),
      allowNull: false,
      comment: "Verification method",
    },
    challengeId: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
      comment: "Unique challenge identifier",
    },
    codeHash: {
      type: DataTypes.STRING(128),
      allowNull: true,
      comment: "Hashed verification code (for email/phone)",
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: "When the challenge expires",
    },
    attempts: {
      type: DataTypes.SMALLINT,
      allowNull: false,
      defaultValue: 0,
      comment: "Number of verification attempts",
    },
    maxAttempts: {
      type: DataTypes.SMALLINT,
      allowNull: false,
      defaultValue: 3,
      comment: "Maximum allowed verification attempts",
    },
    verifiedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "When the challenge was verified",
    },
    rejectedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "When the challenge was rejected",
    },
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "When the challenge was completed",
    },
  },
  {
    sequelize,
    modelName: "RecoveryChallenge",
    tableName: "recovery_challenges",
    timestamps: false,
    underscored: false,
    indexes: [
      {
        fields: ["request_id"],
      },
      {
        fields: ["challenge_id"],
        unique: true,
      },
      {
        fields: ["expires_at"],
      },
      {
        fields: ["verified_at"],
      },
    ],
    comment: "Verification challenges for recovery guardians and contacts",
  }
);

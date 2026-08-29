/**
 * ScopedApiKey model for fine-grained API key management
 * Issue #152
 */

import { Model, DataTypes } from "sequelize";
import { sequelize } from "../db.js";

export class ScopedApiKey extends Model {
  public id!: string;
  public name!: string;
  public prefix!: string;
  public hashedKey!: string;
  public scopes!: Array<{
    resource: string;
    actions: string[];
    conditions?: Record<string, unknown>;
  }>;
  public inheritsFrom!: string | null;
  public ipAllowlist!: string[];
  public ipDenylist!: string[];
  public validFrom!: Date;
  public validUntil!: Date | null;
  public quota!: Record<string, {
    limit: number;
    window: string;
    used: number;
    resetAt: string;
  }>;
  public status!: "active" | "revoked" | "expired" | "suspended";
  public lastUsedAt!: Date | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

ScopedApiKey.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    prefix: {
      type: DataTypes.STRING(8),
      allowNull: false,
      unique: true,
    },
    hashedKey: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    scopes: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    inheritsFrom: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    ipAllowlist: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    ipDenylist: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    validFrom: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    validUntil: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    quota: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },
    status: {
      type: DataTypes.ENUM("active", "revoked", "expired", "suspended"),
      allowNull: false,
      defaultValue: "active",
    },
    lastUsedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "ScopedApiKey",
    tableName: "scoped_api_keys",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["prefix"], unique: true },
      { fields: ["hashed_key"], unique: true },
      { fields: ["user_id"] },
      { fields: ["status"] },
    ],
  }
);

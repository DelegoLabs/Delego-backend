import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

/**
 * Recovery configuration model
 * Stores guardian lists, threshold, and delay settings per account
 */
export class RecoveryConfig extends Model {
  public id!: string;
  public accountId!: string;
  public threshold!: number;
  public delayHours!: number;
  public guardians!: Array<{
    id: string;
    type: string;
    identifier: string;
    verified: boolean;
    weight: number;
    addedAt?: string;
    removedAt?: string;
  }>;
  public emergencyContacts!: Array<{
    id: string;
    name: string;
    email: string;
    phone: string;
    verified: boolean;
    addedAt?: string;
    removedAt?: string;
  }>;
  public lastUpdated!: Date;
}

export interface RecoveryConfigAttributes {
  id: string;
  accountId: string;
  threshold: number;
  delayHours: number;
  guardians: Array<{
    id: string;
    type: string;
    identifier: string;
    verified: boolean;
    weight: number;
    addedAt?: string;
    removedAt?: string;
  }>;
  emergencyContacts: Array<{
    id: string;
    name: string;
    email: string;
    phone: string;
    verified: boolean;
    addedAt?: string;
    removedAt?: string;
  }>;
  lastUpdated: Date;
}

export type RecoveryConfigCreationAttributes = Optional<
  RecoveryConfigAttributes,
  "id" | "lastUpdated"
>;

RecoveryConfig.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    accountId: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
      references: {
        model: "users",
        key: "id",
      },
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
    },
    threshold: {
      type: DataTypes.SMALLINT,
      allowNull: false,
      defaultValue: 3,
      comment: "Minimum weight required for recovery approval",
      validate: {
        min: 1,
      },
    },
    delayHours: {
      type: DataTypes.SMALLINT,
      allowNull: false,
      defaultValue: 168, // 7 days in hours
      comment: "Time delay before recovery can complete",
      validate: {
        min: 1,
        max: 720, // 30 days max
      },
    },
    guardians: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
      comment: "Array of guardian objects with weight and verification status",
    },
    emergencyContacts: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
      comment: "Array of emergency contact objects",
    },
    lastUpdated: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    modelName: "RecoveryConfig",
    tableName: "recovery_configs",
    timestamps: false,
    underscored: false,
    indexes: [
      {
        fields: ["account_id"],
        unique: true,
      },
    ],
    comment: "Account recovery configuration with guardians and emergency contacts",
  }
);

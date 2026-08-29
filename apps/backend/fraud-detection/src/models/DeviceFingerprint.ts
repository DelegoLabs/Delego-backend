import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

export interface DeviceFingerprintAttributes {
  id: string;
  fingerprint: string;
  customerId?: string;
  deviceType: string;
  browser: string;
  os: string;
  ipAddresses: string[];
  firstSeen: Date;
  lastSeen: Date;
  totalTransactions: number;
  flaggedTransactions: number;
  isFlagged: boolean;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

export type DeviceFingerprintCreationAttributes = Optional<DeviceFingerprintAttributes, "id" | "createdAt" | "updatedAt">;

export class DeviceFingerprint extends Model<DeviceFingerprintAttributes, DeviceFingerprintCreationAttributes> {
  public id!: string;
  public fingerprint!: string;
  public customerId?: string;
  public deviceType!: string;
  public browser!: string;
  public os!: string;
  public ipAddresses!: string[];
  public firstSeen!: Date;
  public lastSeen!: Date;
  public totalTransactions!: number;
  public flaggedTransactions!: number;
  public isFlagged!: boolean;
  public metadata?: Record<string, unknown>;
}

DeviceFingerprint.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    fingerprint: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
    },
    customerId: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: "customer_id",
    },
    deviceType: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    browser: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    os: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    ipAddresses: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    firstSeen: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    lastSeen: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    totalTransactions: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    flaggedTransactions: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    isFlagged: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "DeviceFingerprint",
    tableName: "device_fingerprints",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["fingerprint"], unique: true },
      { fields: ["customer_id"] },
      { fields: ["is_flagged"] },
    ],
  }
);

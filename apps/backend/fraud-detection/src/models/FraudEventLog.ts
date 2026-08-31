import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

export interface FraudEventLogAttributes {
  id: string;
  eventId: string;
  eventType: string;
  transactionId?: string;
  customerId?: string;
  details: Record<string, unknown>;
  severity: "info" | "warning" | "error" | "critical";
  createdAt?: Date;
}

export type FraudEventLogCreationAttributes = Optional<FraudEventLogAttributes, "id" | "createdAt">;

export class FraudEventLog extends Model<FraudEventLogAttributes, FraudEventLogCreationAttributes> {
  public id!: string;
  public eventId!: string;
  public eventType!: string;
  public transactionId?: string;
  public customerId?: string;
  public details!: Record<string, unknown>;
  public severity!: string;
}

FraudEventLog.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    eventId: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    eventType: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    transactionId: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: "transaction_id",
    },
    customerId: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: "customer_id",
    },
    details: {
      type: DataTypes.JSONB,
      allowNull: false,
    },
    severity: {
      type: DataTypes.ENUM("info", "warning", "error", "critical"),
      defaultValue: "info",
    },
  },
  {
    sequelize,
    modelName: "FraudEventLog",
    tableName: "fraud_event_logs",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["event_id"], unique: true },
      { fields: ["transaction_id"] },
      { fields: ["customer_id"] },
      { fields: ["event_type"] },
      { fields: ["severity"] },
    ],
  }
);

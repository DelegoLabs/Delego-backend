import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

export interface RevenueAttributionAttributes {
  id: string;
  notificationEventId: string;
  orderId?: string;
  amount: number;
  currency: string;
  category?: string;
  metadata?: Record<string, unknown>;
  attributedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export type RevenueAttributionCreationAttributes = Optional<RevenueAttributionAttributes, "id" | "createdAt" | "updatedAt">;

export class RevenueAttribution extends Model<RevenueAttributionAttributes, RevenueAttributionCreationAttributes> {
  public id!: string;
  public notificationEventId!: string;
  public orderId?: string;
  public amount!: number;
  public currency!: string;
  public category?: string;
  public metadata?: Record<string, unknown>;
}

RevenueAttribution.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    notificationEventId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "notification_event_id",
      references: {
        model: "notification_events",
        key: "id",
      },
    },
    orderId: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: "order_id",
    },
    amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },
    currency: {
      type: DataTypes.STRING(3),
      allowNull: false,
      defaultValue: "USD",
    },
    category: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    attributedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "attributed_at",
    },
  },
  {
    sequelize,
    modelName: "RevenueAttribution",
    tableName: "revenue_attributions",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["notification_event_id"], unique: true },
      { fields: ["order_id"] },
      { fields: ["category"] },
    ],
  }
);

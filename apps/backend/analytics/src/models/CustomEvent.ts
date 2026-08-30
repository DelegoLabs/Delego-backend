import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

export interface CustomEventAttributes {
  id: string;
  userId?: string;
  sessionId?: string;
  eventName: string;
  properties?: Record<string, unknown>;
  timestamp: Date;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export type CustomEventCreationAttributes = Optional<CustomEventAttributes, "id" | "createdAt">;

export class CustomEvent extends Model<CustomEventAttributes, CustomEventCreationAttributes> {
  public id!: string;
  public userId?: string;
  public sessionId?: string;
  public eventName!: string;
  public properties?: Record<string, unknown>;
  public timestamp!: Date;
  public metadata?: Record<string, unknown>;
}

CustomEvent.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "user_id",
    },
    sessionId: {
      type: DataTypes.STRING(50),
      allowNull: true,
      field: "session_id",
    },
    eventName: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    properties: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    timestamp: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "CustomEvent",
    tableName: "custom_events",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["user_id"] },
      { fields: ["session_id"] },
      { fields: ["event_name"] },
      { fields: ["timestamp"] },
    ],
  }
);

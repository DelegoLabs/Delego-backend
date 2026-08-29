import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

export interface NotificationEventAttributes {
  id: string;
  notificationId: string;
  userId?: string;
  templateId: string;
  channel: string;
  eventType: "sent" | "delivered" | "opened" | "clicked" | "converted" | "unsubscribed" | "bounced" | "complained";
  timestamp: Date;
  metadata?: Record<string, unknown>;
  sessionId?: string;
  ipAddress?: string;
  userAgent?: string;
  referenceId?: string; // For A/B testing variant reference
  revenue?: number;
}

export type NotificationEventCreationAttributes = Optional<NotificationEventAttributes, "id" | "timestamp">;

export class NotificationEvent extends Model<NotificationEventAttributes, NotificationEventCreationAttributes> {
  public id!: string;
  public notificationId!: string;
  public userId?: string;
  public templateId!: string;
  public channel!: string;
  public eventType!: string;
  public timestamp!: Date;
  public metadata?: Record<string, unknown>;
  public sessionId?: string;
  public ipAddress?: string;
  public userAgent?: string;
  public referenceId?: string;
  public revenue?: number;
}

NotificationEvent.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    notificationId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "notification_id",
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "user_id",
    },
    templateId: {
      type: DataTypes.STRING(100),
      allowNull: false,
      field: "template_id",
    },
    channel: {
      type: DataTypes.ENUM("email", "push", "sms", "in-app"),
      allowNull: false,
    },
    eventType: {
      type: DataTypes.ENUM("sent", "delivered", "opened", "clicked", "converted", "unsubscribed", "bounced", "complained"),
      allowNull: false,
    },
    timestamp: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    sessionId: {
      type: DataTypes.STRING(50),
      allowNull: true,
      field: "session_id",
    },
    ipAddress: {
      type: DataTypes.INET,
      allowNull: true,
      field: "ip_address",
    },
    userAgent: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "user_agent",
    },
    referenceId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "reference_id",
    },
    revenue: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "NotificationEvent",
    tableName: "notification_events",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["notification_id"] },
      { fields: ["user_id"] },
      { fields: ["template_id"] },
      { fields: ["channel"] },
      { fields: ["event_type"] },
      { fields: ["timestamp"] },
      { fields: ["reference_id"] },
      { fields: ["template_id", "channel", "event_type"] },
    ],
  }
);

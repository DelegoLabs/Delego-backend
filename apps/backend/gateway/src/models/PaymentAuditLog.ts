import { Model, DataTypes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * Audit log for payment method vault operations
 * Immutable logging for PCI DSS compliance
 */
export class PaymentAuditLog extends Model {
  public id!: string;
  public eventId!: string;
  public timestamp!: Date;
  public eventType!: 
    | "payment_method_created"
    | "payment_method_updated"
    | "payment_method_verified"
    | "payment_method_removed"
    | "payment_method_tokenized"
    | "payment_method_network_tokenized"
    | "payment_method_3ds_verified"
    | "payment_method_imported";
  public actorId!: string;
  public actorType!: "user" | "system" | "api_key";
  public resourceId!: string;
  public resourceType!: "payment_method";
  public details!: Record<string, unknown>;
  public ipAddress?: string;
  public userAgent?: string;
  public signature?: string;
}

PaymentAuditLog.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    eventId: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: "Unique event ID for deduplication",
    },
    timestamp: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: "When the event occurred",
    },
    eventType: {
      type: DataTypes.ENUM(
        "payment_method_created",
        "payment_method_updated",
        "payment_method_verified",
        "payment_method_removed",
        "payment_method_tokenized",
        "payment_method_network_tokenized",
        "payment_method_3ds_verified",
        "payment_method_imported"
      ),
      allowNull: false,
      comment: "Type of event being logged",
    },
    actorId: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: "ID of the actor who triggered the event",
    },
    actorType: {
      type: DataTypes.ENUM("user", "system", "api_key"),
      allowNull: false,
      comment: "Type of actor (user, system, api_key)",
    },
    resourceId: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: "ID of the payment method resource",
    },
    resourceType: {
      type: DataTypes.ENUM("payment_method"),
      allowNull: false,
      defaultValue: "payment_method",
      comment: "Type of resource",
    },
    details: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
      comment: "Additional details about the event",
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
    signature: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: "Digital signature for integrity verification",
    },
  },
  {
    sequelize,
    modelName: "PaymentAuditLog",
    tableName: "payment_audit_logs",
    timestamps: false,
    indexes: [
      {
        fields: ["event_id"],
        unique: true,
      },
      {
        fields: ["resource_id"],
      },
      {
        fields: ["event_type"],
      },
      {
        fields: ["timestamp"],
      },
    ],
    comment: "Immutable audit log for PCI DSS compliance",
  }
);

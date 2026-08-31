import { QueryInterface, Sequelize, DataTypes } from "sequelize";

/**
 * Migration: Create notification_events table
 * This migration creates the core table for tracking notification delivery funnel.
 */
export async function up(queryInterface: QueryInterface, Sequelize: Sequelize): Promise<void> {
  await queryInterface.createTable("notification_events", {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      allowNull: false,
    },
    notification_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    template_id: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    channel: {
      type: DataTypes.ENUM("email", "push", "sms", "in-app"),
      allowNull: false,
    },
    event_type: {
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
    session_id: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    ip_address: {
      type: DataTypes.INET,
      allowNull: true,
    },
    user_agent: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    reference_id: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    revenue: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
    },
  });

  // Create indexes for common query patterns
  await queryInterface.addIndex("notification_events", ["notification_id"]);
  await queryInterface.addIndex("notification_events", ["user_id"]);
  await queryInterface.addIndex("notification_events", ["template_id"]);
  await queryInterface.addIndex("notification_events", ["channel"]);
  await queryInterface.addIndex("notification_events", ["event_type"]);
  await queryInterface.addIndex("notification_events", ["timestamp"]);
  await queryInterface.addIndex("notification_events", ["reference_id"]);
  await queryInterface.addIndex("notification_events", ["template_id", "channel", "event_type"]);
}

export async function down(queryInterface: QueryInterface, Sequelize: Sequelize): Promise<void> {
  await queryInterface.dropTable("notification_events");
}

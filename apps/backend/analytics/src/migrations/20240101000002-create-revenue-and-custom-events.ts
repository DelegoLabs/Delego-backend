import { QueryInterface, Sequelize, DataTypes } from "sequelize";

/**
 * Migration: Create revenue attribution and custom events tables
 * Enables revenue tracking and custom engagement event tracking.
 */
export async function up(queryInterface: QueryInterface, Sequelize: Sequelize): Promise<void> {
  // Create revenue attributions table
  await queryInterface.createTable("revenue_attributions", {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      allowNull: false,
    },
    notification_event_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: "notification_events",
        key: "id",
      },
      onDelete: "CASCADE",
    },
    order_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
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
    attributed_at: {
      type: DataTypes.DATE,
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

  // Create custom events table
  await queryInterface.createTable("custom_events", {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      allowNull: false,
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    session_id: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    event_name: {
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
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
    },
  });

  // Create data export logs table
  await queryInterface.createTable("data_export_logs", {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      allowNull: false,
    },
    export_type: {
      type: DataTypes.ENUM("funnel", "engagement", "cohorts", "ab-tests", "custom"),
      allowNull: false,
    },
    format: {
      type: DataTypes.ENUM("csv", "json", "parquet"),
      defaultValue: "csv",
    },
    status: {
      type: DataTypes.ENUM("pending", "processing", "completed", "failed"),
      defaultValue: "pending",
    },
    destination: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    file_key: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    row_count: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    size_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
    error: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    completed_at: {
      type: DataTypes.DATE,
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

  // Create indexes
  await queryInterface.addIndex("revenue_attributions", ["notification_event_id"], { unique: true });
  await queryInterface.addIndex("revenue_attributions", ["order_id"]);
  await queryInterface.addIndex("revenue_attributions", ["category"]);
  await queryInterface.addIndex("custom_events", ["user_id"]);
  await queryInterface.addIndex("custom_events", ["session_id"]);
  await queryInterface.addIndex("custom_events", ["event_name"]);
  await queryInterface.addIndex("custom_events", ["timestamp"]);
  await queryInterface.addIndex("data_export_logs", ["export_type"]);
  await queryInterface.addIndex("data_export_logs", ["status"]);
  await queryInterface.addIndex("data_export_logs", ["created_at"]);
}

export async function down(queryInterface: QueryInterface, Sequelize: Sequelize): Promise<void> {
  await queryInterface.dropTable("data_export_logs");
  await queryInterface.dropTable("custom_events");
  await queryInterface.dropTable("revenue_attributions");
}

/**
 * Migration: Create revenue attribution and custom events tables
 * Enables revenue tracking and custom engagement event tracking.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Create revenue attributions table
    await queryInterface.createTable("revenue_attributions", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      notification_event_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: "notification_events",
          key: "id",
        },
        onDelete: "CASCADE",
      },
      order_id: {
        type: Sequelize.STRING(100),
        allowNull: true,
      },
      amount: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: false,
      },
      currency: {
        type: Sequelize.STRING(3),
        allowNull: false,
        defaultValue: "USD",
      },
      category: {
        type: Sequelize.STRING(100),
        allowNull: true,
      },
      metadata: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      attributed_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
    });

    // Create custom events table
    await queryInterface.createTable("custom_events", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      user_id: {
        type: Sequelize.UUID,
        allowNull: true,
      },
      session_id: {
        type: Sequelize.STRING(50),
        allowNull: true,
      },
      event_name: {
        type: Sequelize.STRING(100),
        allowNull: false,
      },
      properties: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      timestamp: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      metadata: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
    });

    // Create data export logs table
    await queryInterface.createTable("data_export_logs", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      export_type: {
        type: Sequelize.ENUM("funnel", "engagement", "cohorts", "ab-tests", "custom"),
        allowNull: false,
      },
      format: {
        type: Sequelize.ENUM("csv", "json", "parquet"),
        defaultValue: "csv",
      },
      status: {
        type: Sequelize.ENUM("pending", "processing", "completed", "failed"),
        defaultValue: "pending",
      },
      destination: {
        type: Sequelize.STRING(500),
        allowNull: false,
      },
      file_key: {
        type: Sequelize.STRING(500),
        allowNull: true,
      },
      row_count: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      size_bytes: {
        type: Sequelize.BIGINT,
        allowNull: true,
      },
      error: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      metadata: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      completed_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
      updated_at: {
        type: Sequelize.DATE,
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
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable("data_export_logs");
    await queryInterface.dropTable("custom_events");
    await queryInterface.dropTable("revenue_attributions");
  },
};

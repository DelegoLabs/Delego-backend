/**
 * Migration: Create notification_events table
 * This migration creates the core table for tracking notification delivery funnel.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("notification_events", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      notification_id: {
        type: Sequelize.UUID,
        allowNull: false,
      },
      user_id: {
        type: Sequelize.UUID,
        allowNull: true,
      },
      template_id: {
        type: Sequelize.STRING(100),
        allowNull: false,
      },
      channel: {
        type: Sequelize.ENUM("email", "push", "sms", "in-app"),
        allowNull: false,
      },
      event_type: {
        type: Sequelize.ENUM("sent", "delivered", "opened", "clicked", "converted", "unsubscribed", "bounced", "complained"),
        allowNull: false,
      },
      timestamp: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      metadata: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      session_id: {
        type: Sequelize.STRING(50),
        allowNull: true,
      },
      ip_address: {
        type: Sequelize.INET,
        allowNull: true,
      },
      user_agent: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      reference_id: {
        type: Sequelize.UUID,
        allowNull: true,
      },
      revenue: {
        type: Sequelize.DECIMAL(10, 2),
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

    // Create indexes for common query patterns
    await queryInterface.addIndex("notification_events", ["notification_id"]);
    await queryInterface.addIndex("notification_events", ["user_id"]);
    await queryInterface.addIndex("notification_events", ["template_id"]);
    await queryInterface.addIndex("notification_events", ["channel"]);
    await queryInterface.addIndex("notification_events", ["event_type"]);
    await queryInterface.addIndex("notification_events", ["timestamp"]);
    await queryInterface.addIndex("notification_events", ["reference_id"]);
    await queryInterface.addIndex("notification_events", ["template_id", "channel", "event_type"]);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable("notification_events");
  },
};

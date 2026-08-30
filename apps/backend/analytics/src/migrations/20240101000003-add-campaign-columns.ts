import { QueryInterface, Sequelize, DataTypes } from "sequelize";

/**
 * Migration: Add campaign tracking columns to notification_events
 * Adds columns for tracking campaign information and attribution.
 */
export async function up(queryInterface: QueryInterface, Sequelize: Sequelize): Promise<void> {
  // Add campaign_id column
  await queryInterface.addColumn("notification_events", "campaign_id", {
    type: DataTypes.STRING(100),
    allowNull: true,
  });

  // Add utm_source column
  await queryInterface.addColumn("notification_events", "utm_source", {
    type: DataTypes.STRING(100),
    allowNull: true,
  });

  // Add utm_medium column
  await queryInterface.addColumn("notification_events", "utm_medium", {
    type: DataTypes.STRING(100),
    allowNull: true,
  });

  // Add utm_campaign column
  await queryInterface.addColumn("notification_events", "utm_campaign", {
    type: DataTypes.STRING(100),
    allowNull: true,
  });

  // Add utm_term column
  await queryInterface.addColumn("notification_events", "utm_term", {
    type: DataTypes.STRING(100),
    allowNull: true,
  });

  // Add utm_content column
  await queryInterface.addColumn("notification_events", "utm_content", {
    type: DataTypes.STRING(100),
    allowNull: true,
  });

  // Create index for campaign_id
  await queryInterface.addIndex("notification_events", ["campaign_id"]);
  await queryInterface.addIndex("notification_events", ["utm_source", "utm_medium", "utm_campaign"]);
}

export async function down(queryInterface: QueryInterface, Sequelize: Sequelize): Promise<void> {
  await queryInterface.removeColumn("notification_events", "campaign_id");
  await queryInterface.removeColumn("notification_events", "utm_source");
  await queryInterface.removeColumn("notification_events", "utm_medium");
  await queryInterface.removeColumn("notification_events", "utm_campaign");
  await queryInterface.removeColumn("notification_events", "utm_term");
  await queryInterface.removeColumn("notification_events", "utm_content");
}

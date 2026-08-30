/**
 * Migration: Add campaign tracking columns to notification_events
 * Adds columns for tracking campaign information and attribution.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Add campaign_id column
    await queryInterface.addColumn("notification_events", "campaign_id", {
      type: Sequelize.STRING(100),
      allowNull: true,
      after: "template_id",
    });

    // Add utm_source column
    await queryInterface.addColumn("notification_events", "utm_source", {
      type: Sequelize.STRING(100),
      allowNull: true,
      after: "campaign_id",
    });

    // Add utm_medium column
    await queryInterface.addColumn("notification_events", "utm_medium", {
      type: Sequelize.STRING(100),
      allowNull: true,
      after: "utm_source",
    });

    // Add utm_campaign column
    await queryInterface.addColumn("notification_events", "utm_campaign", {
      type: Sequelize.STRING(100),
      allowNull: true,
      after: "utm_medium",
    });

    // Add utm_term column
    await queryInterface.addColumn("notification_events", "utm_term", {
      type: Sequelize.STRING(100),
      allowNull: true,
      after: "utm_campaign",
    });

    // Add utm_content column
    await queryInterface.addColumn("notification_events", "utm_content", {
      type: Sequelize.STRING(100),
      allowNull: true,
      after: "utm_term",
    });

    // Create index for campaign_id
    await queryInterface.addIndex("notification_events", ["campaign_id"]);
    await queryInterface.addIndex("notification_events", ["utm_source", "utm_medium", "utm_campaign"]);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn("notification_events", "campaign_id");
    await queryInterface.removeColumn("notification_events", "utm_source");
    await queryInterface.removeColumn("notification_events", "utm_medium");
    await queryInterface.removeColumn("notification_events", "utm_campaign");
    await queryInterface.removeColumn("notification_events", "utm_term");
    await queryInterface.removeColumn("notification_events", "utm_content");
  },
};

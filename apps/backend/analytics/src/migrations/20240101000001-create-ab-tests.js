/**
 * Migration: Create A/B testing tables
 * Creates tables for managing A/B tests and their variants.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Create AB tests table
    await queryInterface.createTable("ab_tests", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      hypothesis: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      status: {
        type: Sequelize.ENUM("draft", "running", "completed", "archived"),
        defaultValue: "draft",
      },
      start_date: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      end_date: {
        type: Sequelize.DATE,
        allowNull: true,
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
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
    });

    // Create AB test variants table
    await queryInterface.createTable("ab_test_variants", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      ab_test_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: "ab_tests",
          key: "id",
        },
        onDelete: "CASCADE",
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      template_id: {
        type: Sequelize.STRING(100),
        allowNull: false,
      },
      traffic_split: {
        type: Sequelize.DECIMAL(5, 2),
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
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
    });

    // Create cohort analyses table
    await queryInterface.createTable("cohort_analyses", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      cohort: {
        type: Sequelize.STRING(20),
        allowNull: false,
      },
      period: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      size: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      retained: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      engagement_rate: {
        type: Sequelize.DECIMAL(5, 4),
        allowNull: false,
        defaultValue: 0,
      },
      revenue_per_user: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
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
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
    });

    // Create indexes
    await queryInterface.addIndex("ab_tests", ["status"]);
    await queryInterface.addIndex("ab_tests", ["start_date"]);
    await queryInterface.addIndex("ab_test_variants", ["ab_test_id"]);
    await queryInterface.addIndex("ab_test_variants", ["template_id"]);
    await queryInterface.addIndex("cohort_analyses", ["cohort"]);
    await queryInterface.addIndex("cohort_analyses", ["cohort", "period"], { unique: true });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable("ab_test_variants");
    await queryInterface.dropTable("ab_tests");
    await queryInterface.dropTable("cohort_analyses");
  },
};

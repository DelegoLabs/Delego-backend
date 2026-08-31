import { QueryInterface, Sequelize, DataTypes } from "sequelize";

/**
 * Migration: Create A/B testing tables
 * Creates tables for managing A/B tests and their variants.
 */
export async function up(queryInterface: QueryInterface, Sequelize: Sequelize): Promise<void> {
  // Create AB tests table
  await queryInterface.createTable("ab_tests", {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    hypothesis: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM("draft", "running", "completed", "archived"),
      defaultValue: "draft",
    },
    start_date: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    end_date: {
      type: DataTypes.DATE,
      allowNull: true,
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
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
    },
  });

  // Create AB test variants table
  await queryInterface.createTable("ab_test_variants", {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      allowNull: false,
    },
    ab_test_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: "ab_tests",
        key: "id",
      },
      onDelete: "CASCADE",
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    template_id: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    traffic_split: {
      type: DataTypes.DECIMAL(5, 2),
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
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
    },
  });

  // Create cohort analyses table
  await queryInterface.createTable("cohort_analyses", {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      allowNull: false,
    },
    cohort: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    period: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    size: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    retained: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    engagement_rate: {
      type: DataTypes.DECIMAL(5, 4),
      allowNull: false,
      defaultValue: 0,
    },
    revenue_per_user: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
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
    updated_at: {
      type: DataTypes.DATE,
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
}

export async function down(queryInterface: QueryInterface, Sequelize: Sequelize): Promise<void> {
  await queryInterface.dropTable("ab_test_variants");
  await queryInterface.dropTable("ab_tests");
  await queryInterface.dropTable("cohort_analyses");
}

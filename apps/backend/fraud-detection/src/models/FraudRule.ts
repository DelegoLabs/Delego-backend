import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

export interface FraudRuleAttributes {
  id: string;
  name: string;
  description: string;
  condition: string;
  action: "flag" | "review" | "block";
  scoreImpact: number;
  enabled: boolean;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

export type FraudRuleCreationAttributes = Optional<FraudRuleAttributes, "id" | "createdAt" | "updatedAt">;

export class FraudRule extends Model<FraudRuleAttributes, FraudRuleCreationAttributes> {
  public id!: string;
  public name!: string;
  public description!: string;
  public condition!: string;
  public action!: string;
  public scoreImpact!: number;
  public enabled!: boolean;
  public metadata?: Record<string, unknown>;
}

FraudRule.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    condition: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: "JavaScript expression for rule evaluation",
    },
    action: {
      type: DataTypes.ENUM("flag", "review", "block"),
      allowNull: false,
    },
    scoreImpact: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "FraudRule",
    tableName: "fraud_rules",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["enabled"] },
      { fields: ["action"] },
    ],
  }
);

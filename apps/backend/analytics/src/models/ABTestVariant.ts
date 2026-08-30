import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

export interface ABTestVariantAttributes {
  id: string;
  abTestId: string;
  name: string;
  templateId: string;
  trafficSplit: number;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

export type ABTestVariantCreationAttributes = Optional<ABTestVariantAttributes, "id" | "createdAt" | "updatedAt">;

export class ABTestVariant extends Model<ABTestVariantAttributes, ABTestVariantCreationAttributes> {
  public id!: string;
  public abTestId!: string;
  public name!: string;
  public templateId!: string;
  public trafficSplit!: number;
  public metadata?: Record<string, unknown>;
}

ABTestVariant.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    abTestId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "ab_test_id",
      references: {
        model: "ab_tests",
        key: "id",
      },
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    templateId: {
      type: DataTypes.STRING(100),
      allowNull: false,
      field: "template_id",
    },
    trafficSplit: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
      validate: {
        min: 0,
        max: 100,
      },
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "ABTestVariant",
    tableName: "ab_test_variants",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["ab_test_id"] },
      { fields: ["template_id"] },
    ],
  }
);

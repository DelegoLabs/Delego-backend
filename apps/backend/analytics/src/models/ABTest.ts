import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

export interface ABTestAttributes {
  id: string;
  name: string;
  hypothesis: string;
  status: "draft" | "running" | "completed" | "archived";
  startDate: Date;
  endDate?: Date;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

export type ABTestCreationAttributes = Optional<ABTestAttributes, "id" | "createdAt" | "updatedAt">;

export class ABTest extends Model<ABTestAttributes, ABTestCreationAttributes> {
  public id!: string;
  public name!: string;
  public hypothesis!: string;
  public status!: string;
  public startDate!: Date;
  public endDate?: Date;
  public metadata?: Record<string, unknown>;
}

ABTest.init(
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
    hypothesis: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM("draft", "running", "completed", "archived"),
      defaultValue: "draft",
    },
    startDate: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    endDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "ABTest",
    tableName: "ab_tests",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["status"] },
      { fields: ["start_date"] },
    ],
  }
);

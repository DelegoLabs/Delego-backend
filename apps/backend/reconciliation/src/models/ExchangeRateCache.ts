import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

export interface ExchangeRateCacheAttributes {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  source: string;
  validFrom: Date;
  validTo?: Date;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export type ExchangeRateCacheCreationAttributes = Optional<ExchangeRateCacheAttributes, "id" | "createdAt">;

export class ExchangeRateCache extends Model<ExchangeRateCacheAttributes, ExchangeRateCacheCreationAttributes> {
  public id!: string;
  public fromCurrency!: string;
  public toCurrency!: string;
  public rate!: number;
  public source!: string;
  public validFrom!: Date;
  public validTo?: Date;
  public metadata?: Record<string, unknown>;
}

ExchangeRateCache.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    fromCurrency: {
      type: DataTypes.STRING(3),
      allowNull: false,
    },
    toCurrency: {
      type: DataTypes.STRING(3),
      allowNull: false,
    },
    rate: {
      type: DataTypes.DECIMAL(18, 8),
      allowNull: false,
    },
    source: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    validFrom: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    validTo: {
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
    modelName: "ExchangeRateCache",
    tableName: "exchange_rate_cache",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["from_currency", "to_currency"] },
      { fields: ["valid_from", "valid_to"] },
    ],
  }
);

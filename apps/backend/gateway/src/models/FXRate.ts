import { Model, DataTypes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * FX rate model
 * Stores real-time and historical FX rates for multi-currency payments
 */
export class FXRate extends Model {
  public id!: string;
  public baseCurrency!: string;
  public quoteCurrency!: string;
  public rate!: string;
  public source!: string;
  public timestamp!: Date;
  public validUntil!: Date;
  public spread!: string;
  public midRate!: string;
  public bid!: string;
  public ask!: string;
  public lastUpdated!: Date;
}

FXRate.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    baseCurrency: {
      type: DataTypes.STRING(12),
      allowNull: false,
      comment: "Base currency code",
    },
    quoteCurrency: {
      type: DataTypes.STRING(12),
      allowNull: false,
      comment: "Quote currency code",
    },
    rate: {
      type: DataTypes.DECIMAL(24, 12),
      allowNull: false,
      comment: "Exchange rate (quote per base)",
    },
    source: {
      type: DataTypes.STRING(50),
      allowNull: false,
      comment: "Rate provider source",
    },
    timestamp: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: "When rate was fetched",
    },
    validUntil: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: "When rate expires and needs refresh",
    },
    spread: {
      type: DataTypes.DECIMAL(12, 6),
      allowNull: false,
      defaultValue: "0.005", // 0.5% spread by default
      comment: "Spread applied to the rate",
    },
    midRate: {
      type: DataTypes.DECIMAL(24, 12),
      allowNull: false,
      comment: "Mid-market rate",
    },
    bid: {
      type: DataTypes.DECIMAL(24, 12),
      allowNull: false,
      comment: "Bid price",
    },
    ask: {
      type: DataTypes.DECIMAL(24, 12),
      allowNull: false,
      comment: "Ask price",
    },
    lastUpdated: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    modelName: "FXRate",
    tableName: "fx_rates",
    timestamps: false,
    underscored: false,
    indexes: [
      {
        fields: ["base_currency", "quote_currency"],
        unique: true,
      },
      {
        fields: ["valid_until"],
      },
      {
        fields: ["source"],
      },
    ],
    comment: "FX rates for multi-currency payment conversion",
  }
);

// Pre-save hook to update timestamps
FXRate.beforeSave((rate) => {
  rate.set("lastUpdated", new Date());
});

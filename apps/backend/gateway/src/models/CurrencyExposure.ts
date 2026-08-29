import { Model, DataTypes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * Currency exposure model
 * Tracks exposure, risk metrics, and hedging for each currency
 */
export class CurrencyExposure extends Model {
  public id!: string;
  public currency!: string;
  public grossAmount!: string;
  public netAmount!: string;
  public unrealizedPnL!: string;
  public hedgeRatio!: number;
  public var95!: string;
  public var99!: string;
  public marginRequirement!: string;
  public collateralRequired!: string;
  public exposureDate!: Date;
  public hedgeStatus!: "unhedged" | "partially_hedged" | "fully_hedged";
  public lastCalculated!: Date;
}

CurrencyExposure.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    currency: {
      type: DataTypes.STRING(12),
      allowNull: false,
      comment: "Currency code",
    },
    grossAmount: {
      type: DataTypes.DECIMAL(24, 12),
      allowNull: false,
      comment: "Total gross exposure amount",
    },
    netAmount: {
      type: DataTypes.DECIMAL(24, 12),
      allowNull: false,
      comment: "Net exposure after offsets",
    },
    unrealizedPnL: {
      type: DataTypes.DECIMAL(24, 12),
      allowNull: false,
      defaultValue: "0",
      comment: "Unrealized profit/loss",
    },
    hedgeRatio: {
      type: DataTypes.DECIMAL(6, 4),
      allowNull: false,
      defaultValue: 0,
      comment: "Hedge ratio (0 to 1)",
    },
    var95: {
      type: DataTypes.DECIMAL(24, 12),
      allowNull: false,
      comment: "Value at Risk 95%",
    },
    var99: {
      type: DataTypes.DECIMAL(24, 12),
      allowNull: false,
      comment: "Value at Risk 99%",
    },
    marginRequirement: {
      type: DataTypes.DECIMAL(24, 12),
      allowNull: false,
      comment: "Required margin for this exposure",
    },
    collateralRequired: {
      type: DataTypes.DECIMAL(24, 12),
      allowNull: false,
      comment: "Required collateral",
    },
    exposureDate: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: "Date of exposure calculation",
    },
    hedgeStatus: {
      type: DataTypes.ENUM("unhedged", "partially_hedged", "fully_hedged"),
      allowNull: false,
      defaultValue: "unhedged",
      comment: "Hedging status",
    },
    lastCalculated: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    modelName: "CurrencyExposure",
    tableName: "currency_exposures",
    timestamps: false,
    underscored: false,
    indexes: [
      {
        fields: ["currency"],
        unique: true,
      },
      {
        fields: ["exposure_date"],
      },
      {
        fields: ["hedge_status"],
      },
    ],
    comment: "Currency exposure and risk metrics",
  }
);

// Pre-save hook to update timestamps
CurrencyExposure.beforeSave((exposure) => {
  exposure.set("lastCalculated", new Date());
});

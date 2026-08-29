import { Model, DataTypes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * Supported currencies model
 * Stores configuration for each currency that can be used in payments
 */
export class SupportedCurrency extends Model {
  public code!: string;
  public issuer!: string;
  public assetType!: "native" | "issued";
  public decimals!: number;
  public fxProvider!: string;
  public settlementEnabled!: boolean;
  public complianceFlags!: string[];
  public enabled!: boolean;
  public createdAt!: Date;
  public updatedAt!: Date;
}

SupportedCurrency.init(
  {
    code: {
      type: DataTypes.STRING(12),
      allowNull: false,
      primaryKey: true,
      comment: "Currency code (e.g., XLM, USDC, EURC)",
    },
    issuer: {
      type: DataTypes.STRING(56),
      allowNull: false,
      comment: "Issuer Stellar address for issued assets",
    },
    assetType: {
      type: DataTypes.ENUM("native", "issued"),
      allowNull: false,
      comment: "Asset type",
    },
    decimals: {
      type: DataTypes.SMALLINT,
      allowNull: false,
      defaultValue: 7,
      comment: "Number of decimal places",
      validate: {
        min: 0,
        max: 9,
      },
    },
    fxProvider: {
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: "stellar_lumen",
      comment: "FX rate provider identifier",
    },
    settlementEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: "Enable settlement in this currency",
    },
    complianceFlags: {
      type: DataTypes.ARRAY(DataTypes.STRING(50)),
      allowNull: false,
      defaultValue: [],
      comment: "Compliance requirements (KYC, AML, etc.)",
    },
    enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: "Is this currency currently enabled for payments",
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    modelName: "SupportedCurrency",
    tableName: "supported_currencies",
    timestamps: true,
    underscored: false,
    indexes: [
      {
        fields: ["code"],
      },
      {
        fields: ["issuer"],
      },
      {
        fields: ["asset_type"],
      },
      {
        fields: ["settlement_enabled"],
      },
      {
        fields: ["enabled"],
      },
    ],
    comment: "Configuration for supported currencies in the payment system",
  }
);

// Pre-save hook to update timestamps
SupportedCurrency.beforeSave((currency) => {
  if (currency.changed("settlementEnabled") || currency.changed("enabled")) {
    currency.set("updatedAt", new Date());
  }
});

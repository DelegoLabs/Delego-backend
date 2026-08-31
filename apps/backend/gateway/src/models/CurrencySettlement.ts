import { Model, DataTypes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * Currency settlement model
 * Tracks settlements in each currency
 */
export class CurrencySettlement extends Model {
  public id!: string;
  public currency!: string;
  public totalIn!: string;
  public totalOut!: string;
  public netAmount!: string;
  public settlementDate!: Date;
  public ledgerSequence!: number;
  public status!: "pending" | "in_progress" | "completed" | "failed";
  public transactions!: string[];
  public failedReason?: string;
  public createdAt!: Date;
  public completedAt?: Date;
  public failedAt?: Date;
}

CurrencySettlement.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    currency: {
      type: DataTypes.STRING(12),
      allowNull: false,
      comment: "Settlement currency",
    },
    totalIn: {
      type: DataTypes.DECIMAL(24, 12),
      allowNull: false,
      comment: "Total amount coming in",
    },
    totalOut: {
      type: DataTypes.DECIMAL(24, 12),
      allowNull: false,
      comment: "Total amount going out",
    },
    netAmount: {
      type: DataTypes.DECIMAL(24, 12),
      allowNull: false,
      comment: "Net settlement amount",
    },
    settlementDate: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: "Date of settlement",
    },
    ledgerSequence: {
      type: DataTypes.BIGINT,
      allowNull: false,
      comment: "Stellar ledger sequence",
    },
    status: {
      type: DataTypes.ENUM("pending", "in_progress", "completed", "failed"),
      allowNull: false,
      defaultValue: "pending",
      comment: "Settlement status",
    },
    transactions: {
      type: DataTypes.ARRAY(DataTypes.STRING(64)),
      allowNull: false,
      defaultValue: [],
      comment: "Transaction hashes",
    },
    failedReason: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "Failure reason",
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "When settlement completed",
    },
    failedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "When settlement failed",
    },
  },
  {
    sequelize,
    modelName: "CurrencySettlement",
    tableName: "currency_settlements",
    timestamps: false,
    underscored: false,
    indexes: [
      {
        fields: ["currency", "settlement_date"],
      },
      {
        fields: ["status"],
      },
      {
        fields: ["ledger_sequence"],
      },
    ],
    comment: "Currency settlement records",
  }
);

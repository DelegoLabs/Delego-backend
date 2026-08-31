import { Model, DataTypes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * Multi-currency payment model
 * Tracks payments across different currencies with path payments
 */
export class MultiCurrencyPayment extends Model {
  public id!: string;
  public sourceCurrency!: string;
  public sourceAmount!: string;
  public destinationCurrency!: string;
  public destinationAmount!: string;
  public fxRateId!: string;
  public fxRateData!: Record<string, unknown>;
  public conversionPath!: Array<{
    from: string;
    to: string;
    rate: string;
    amountOut: string;
  }>;
  public settlementCurrency!: string;
  public status!: "pending" | "converting" | "settled" | "failed" | "cancelled";
  public settlementStatus?: "pending" | "in_progress" | "completed" | "failed";
  public stellarTransactionHash?: string;
  public pathPaymentId?: string;
  public sourceAddress!: string;
  public destinationAddress!: string;
  public destinationMin?: string;
  public failedReason?: string;
  public createdAt!: Date;
  public completedAt?: Date;
  public failedAt?: Date;
  public metadata!: Record<string, unknown>;
}

MultiCurrencyPayment.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    sourceCurrency: {
      type: DataTypes.STRING(12),
      allowNull: false,
      comment: "Source currency code",
    },
    sourceAmount: {
      type: DataTypes.DECIMAL(24, 12),
      allowNull: false,
      comment: "Source amount",
    },
    destinationCurrency: {
      type: DataTypes.STRING(12),
      allowNull: false,
      comment: "Destination currency code",
    },
    destinationAmount: {
      type: DataTypes.DECIMAL(24, 12),
      allowNull: false,
      comment: "Destination amount",
    },
    fxRateId: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: "FX rate used for this payment",
    },
    fxRateData: {
      type: DataTypes.JSONB,
      allowNull: false,
      comment: "FX rate details for audit",
    },
    conversionPath: {
      type: DataTypes.JSONB,
      allowNull: false,
      comment: "Path payment route",
    },
    settlementCurrency: {
      type: DataTypes.STRING(12),
      allowNull: false,
      comment: "Currency for final settlement",
    },
    status: {
      type: DataTypes.ENUM("pending", "converting", "settled", "failed", "cancelled"),
      allowNull: false,
      defaultValue: "pending",
      comment: "Payment status",
    },
    settlementStatus: {
      type: DataTypes.ENUM("pending", "in_progress", "completed", "failed"),
      allowNull: true,
      comment: "Settlement status",
    },
    stellarTransactionHash: {
      type: DataTypes.STRING(64),
      allowNull: true,
      comment: "Stellar transaction hash",
    },
    pathPaymentId: {
      type: DataTypes.STRING(64),
      allowNull: true,
      comment: "Path payment operation ID",
    },
    sourceAddress: {
      type: DataTypes.STRING(56),
      allowNull: false,
      comment: "Source wallet address",
    },
    destinationAddress: {
      type: DataTypes.STRING(56),
      allowNull: false,
      comment: "Destination wallet address",
    },
    destinationMin: {
      type: DataTypes.DECIMAL(24, 12),
      allowNull: true,
      comment: "Minimum destination amount (slippage protection)",
    },
    failedReason: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "Failure reason if payment failed",
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "When payment was completed",
    },
    failedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "When payment failed",
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
      comment: "Additional payment metadata",
    },
  },
  {
    sequelize,
    modelName: "MultiCurrencyPayment",
    tableName: "multi_currency_payments",
    timestamps: false,
    underscored: false,
    indexes: [
      {
        fields: ["source_currency", "destination_currency"],
      },
      {
        fields: ["status"],
      },
      {
        fields: ["created_at"],
      },
      {
        fields: ["stellar_transaction_hash"],
      },
      {
        fields: ["source_address"],
      },
      {
        fields: ["destination_address"],
      },
    ],
    comment: "Multi-currency payments with path payment support",
  }
);

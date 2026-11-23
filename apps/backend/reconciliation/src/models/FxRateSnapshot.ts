import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

/**
 * Permanent FX rate snapshot (Issue #622) — one row per hourly capture of a
 * currency pair's rate, archived indefinitely for tax/audit reconstruction
 * of the fiat value of XLM/USDC at order-settlement time. See
 * `database/migrations/20261120120000_fx_rate_snapshots.sql`.
 */
export interface FxRateSnapshotAttributes {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: number;
  source: string;
  capturedAt: Date;
}

export type FxRateSnapshotCreationAttributes = Optional<
  FxRateSnapshotAttributes,
  "id" | "capturedAt" | "source"
>;

export class FxRateSnapshot extends Model<FxRateSnapshotAttributes, FxRateSnapshotCreationAttributes> {
  public id!: string;
  public baseCurrency!: string;
  public quoteCurrency!: string;
  public rate!: number;
  public source!: string;
  public readonly capturedAt!: Date;
}

FxRateSnapshot.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    baseCurrency: {
      type: DataTypes.STRING(12),
      allowNull: false,
      field: "base_currency",
    },
    quoteCurrency: {
      type: DataTypes.STRING(12),
      allowNull: false,
      field: "quote_currency",
    },
    rate: {
      type: DataTypes.DECIMAL(18, 8),
      allowNull: false,
    },
    source: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: "coingecko",
    },
    capturedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: "captured_at",
    },
  },
  {
    sequelize,
    modelName: "FxRateSnapshot",
    tableName: "fx_rate_snapshots",
    timestamps: false,
    underscored: true,
  }
);

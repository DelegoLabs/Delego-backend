import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

/**
 * Durable cursor for the orphan transaction scanner (Issue #621) — one row
 * per watched platform escrow account, storing the Horizon `paging_token`
 * the crawler last processed so a restart resumes instead of rescanning the
 * account's full payment history.
 */
export interface OrphanScannerCheckpointAttributes {
  escrowAccount: string;
  lastCursor: string;
  syncedAt: Date;
  createdAt?: Date;
}

export type OrphanScannerCheckpointCreationAttributes = Optional<
  OrphanScannerCheckpointAttributes,
  "lastCursor" | "syncedAt" | "createdAt"
>;

export class OrphanScannerCheckpoint extends Model<
  OrphanScannerCheckpointAttributes,
  OrphanScannerCheckpointCreationAttributes
> {
  public escrowAccount!: string;
  public lastCursor!: string;
  public syncedAt!: Date;
  public readonly createdAt!: Date;
}

OrphanScannerCheckpoint.init(
  {
    escrowAccount: {
      type: DataTypes.STRING(64),
      primaryKey: true,
      field: "escrow_account",
    },
    lastCursor: {
      type: DataTypes.STRING(64),
      allowNull: false,
      defaultValue: "0",
      field: "last_cursor",
    },
    syncedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: "synced_at",
    },
  },
  {
    sequelize,
    modelName: "OrphanScannerCheckpoint",
    tableName: "orphan_scanner_checkpoints",
    timestamps: true,
    underscored: true,
    updatedAt: false,
  }
);

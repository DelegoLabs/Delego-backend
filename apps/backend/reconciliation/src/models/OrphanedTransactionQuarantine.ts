import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

/**
 * Quarantine row for an incoming Horizon payment the orphan scanner (Issue
 * #621) could not confidently link to a pending order — by memo or by
 * buyer address + exact amount. Held here for manual review rather than
 * silently dropped or auto-matched on a guess.
 */
export type QuarantineStatus = "pending_review" | "resolved" | "dismissed";

export interface OrphanedTransactionQuarantineAttributes {
  id: string;
  txHash: string;
  sourceAccount: string;
  destinationAccount: string;
  amountStroops: string;
  memo: string | null;
  ledgerSequence: number;
  status: QuarantineStatus;
  matchedOrderId: string | null;
  detectedAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
}

export type OrphanedTransactionQuarantineCreationAttributes = Optional<
  OrphanedTransactionQuarantineAttributes,
  "id" | "status" | "matchedOrderId" | "detectedAt" | "reviewedAt" | "reviewedBy"
>;

export class OrphanedTransactionQuarantine extends Model<
  OrphanedTransactionQuarantineAttributes,
  OrphanedTransactionQuarantineCreationAttributes
> {
  public id!: string;
  public txHash!: string;
  public sourceAccount!: string;
  public destinationAccount!: string;
  public amountStroops!: string;
  public memo!: string | null;
  public ledgerSequence!: number;
  public status!: QuarantineStatus;
  public matchedOrderId!: string | null;
  public readonly detectedAt!: Date;
  public reviewedAt!: Date | null;
  public reviewedBy!: string | null;
}

OrphanedTransactionQuarantine.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    txHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: "tx_hash",
      unique: true,
    },
    sourceAccount: {
      type: DataTypes.STRING(56),
      allowNull: false,
      field: "source_account",
    },
    destinationAccount: {
      type: DataTypes.STRING(56),
      allowNull: false,
      field: "destination_account",
    },
    amountStroops: {
      type: DataTypes.BIGINT,
      allowNull: false,
      field: "amount_stroops",
    },
    memo: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    ledgerSequence: {
      type: DataTypes.BIGINT,
      allowNull: false,
      field: "ledger_sequence",
    },
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: "pending_review",
    },
    matchedOrderId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "matched_order_id",
    },
    detectedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: "detected_at",
    },
    reviewedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "reviewed_at",
    },
    reviewedBy: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: "reviewed_by",
    },
  },
  {
    sequelize,
    modelName: "OrphanedTransactionQuarantine",
    tableName: "orphaned_transaction_quarantine",
    timestamps: false,
    underscored: true,
  }
);

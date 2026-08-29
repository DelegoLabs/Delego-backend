import { DataTypes, Model } from "sequelize";
import { sequelize } from "../db.js";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("wallet:auditLog", process.env.LOG_LEVEL ?? "info");

/**
 * Parameters for inserting a signing audit log entry.
 * Deliberately excludes any secret/key material fields.
 */
export interface AuditLogParams {
  walletId: string;
  status: "SUCCESS" | "FAILURE";
  txHash?: string | null;
}

class WalletSigningAuditLog extends Model {
  public id!: string;
  public walletId!: string;
  public txHash!: string | null;
  public status!: "SUCCESS" | "FAILURE";
  public readonly createdAt!: Date;
}

WalletSigningAuditLog.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    walletId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "wallet_id",
    },
    txHash: {
      type: DataTypes.STRING(128),
      allowNull: true,
      field: "tx_hash",
    },
    status: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
  },
  {
    sequelize,
    modelName: "WalletSigningAuditLog",
    tableName: "wallet_signing_audit_logs",
    timestamps: true,
    updatedAt: false,
    underscored: true,
  }
);

/**
 * Inserts a wallet signing audit log entry into the database.
 * Re-throws on DB error so callers can decide how to handle it.
 */
export async function insertAuditLog(params: AuditLogParams): Promise<void> {
  const { walletId, status, txHash = null } = params;
  log.debug("Inserting audit log entry", { walletId, status, txHash });
  try {
    await WalletSigningAuditLog.create({
      walletId,
      status,
      txHash: txHash ?? null,
    });
  } catch (err: unknown) {
    log.error("Failed to insert audit log entry", {
      walletId,
      status,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

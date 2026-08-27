/**
 * Sequelize models for Multi-Signature Wallet support
 * Issue #44
 */
import { Model, DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import type {
  MultiSigSigner,
  ProposalTransaction,
  ProposalSignature,
  ProposalStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// MultiSigWalletModel
// ---------------------------------------------------------------------------

export class MultiSigWalletModel extends Model {
  public id!: string;
  public address!: string;
  public signers!: MultiSigSigner[];
  public threshold!: number;
  public nonce!: number;
  public paused!: boolean;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

MultiSigWalletModel.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    address: {
      type: DataTypes.STRING(56),
      allowNull: false,
      unique: true,
    },
    signers: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    threshold: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    nonce: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    paused: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    sequelize,
    modelName: "MultiSigWallet",
    tableName: "multisig_wallets",
    timestamps: true,
    underscored: true,
  },
);

// ---------------------------------------------------------------------------
// MultiSigProposalModel
// ---------------------------------------------------------------------------

export class MultiSigProposalModel extends Model {
  public id!: string;
  public walletId!: string;
  public proposer!: string;
  public transaction!: ProposalTransaction;
  public signatures!: ProposalSignature[];
  public status!: ProposalStatus;
  public expiresAt!: Date;
  public executedAt!: Date | null;
  public executionHash!: string | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

MultiSigProposalModel.init(
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
    proposer: {
      type: DataTypes.STRING(56),
      allowNull: false,
    },
    transaction: {
      type: DataTypes.JSONB,
      allowNull: false,
    },
    signatures: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    status: {
      type: DataTypes.ENUM(
        "pending",
        "signed",
        "executed",
        "expired",
        "cancelled",
      ),
      allowNull: false,
      defaultValue: "pending",
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "expires_at",
    },
    executedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "executed_at",
    },
    executionHash: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "execution_hash",
    },
  },
  {
    sequelize,
    modelName: "MultiSigProposal",
    tableName: "multisig_proposals",
    timestamps: true,
    underscored: true,
  },
);

// ---------------------------------------------------------------------------
// MultiSigAuditLogModel  — immutable record of all signer / proposal changes
// ---------------------------------------------------------------------------

export class MultiSigAuditLogModel extends Model {
  public id!: string;
  public walletId!: string;
  public eventType!: string;
  public payload!: Record<string, unknown>;
  public performedBy!: string;
  public readonly createdAt!: Date;
}

MultiSigAuditLogModel.init(
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
    eventType: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "event_type",
    },
    payload: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },
    performedBy: {
      type: DataTypes.STRING(56),
      allowNull: false,
      field: "performed_by",
    },
  },
  {
    sequelize,
    modelName: "MultiSigAuditLog",
    tableName: "multisig_audit_logs",
    timestamps: true,
    underscored: true,
    updatedAt: false, // audit log rows are immutable
  },
);

// ---------------------------------------------------------------------------
// Associations
// ---------------------------------------------------------------------------

MultiSigWalletModel.hasMany(MultiSigProposalModel, {
  foreignKey: "wallet_id",
  as: "proposals",
});
MultiSigProposalModel.belongsTo(MultiSigWalletModel, {
  foreignKey: "wallet_id",
  as: "wallet",
});

MultiSigWalletModel.hasMany(MultiSigAuditLogModel, {
  foreignKey: "wallet_id",
  as: "auditLogs",
});

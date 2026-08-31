import { Model, DataTypes, Optional } from "sequelize";
import { sequelize } from "../db.js";

/**
 * Payment method model - PCI DSS SAQ A-EP compliant
 * Stores tokenized payment methods with network tokens for cards
 */
export class PaymentMethod extends Model {
  public id!: string;
  public customerId!: string;
  public type!: "card" | "bank_account" | "wallet" | "stellar_account";
  public token!: string; // Vault token (PAN substitute)
  public brand?: string;
  public last4?: string;
  public expiryMonth?: number;
  public expiryYear?: number;
  public fingerprint!: string; // Unique identifier for the payment method
  public networkToken?: string; // Network token for cards (Visa/Mastercard)
  public networkTokenType?: string;
  public networkTokenExpiryMonth?: number;
  public networkTokenExpiryYear?: number;
  public networkTokenCryptogram?: string;
  public verified!: boolean;
  public verificationMethod!: "none" | "3ds" | "microdeposit" | "instant";
  public metadata!: Record<string, unknown>;
  public status!: "active" | "expired" | "removed";
  public threeDSecureEnabled!: boolean;
  public threeDSecureChallenged?: boolean;
  public threeDSecureVersion?: string;
  public threeDSecureCryptogram?: string;
  public threeDSecureEciFlag?: string;
  public createdAt!: Date;
  public updatedAt!: Date;
  public lastUsedAt?: Date;
  public removedAt?: Date;
}

export interface PaymentMethodAttributes {
  id: string;
  customerId: string;
  type: "card" | "bank_account" | "wallet" | "stellar_account";
  token: string;
  brand?: string;
  last4?: string;
  expiryMonth?: number;
  expiryYear?: number;
  fingerprint: string;
  networkToken?: string;
  networkTokenType?: string;
  networkTokenExpiryMonth?: number;
  networkTokenExpiryYear?: number;
  networkTokenCryptogram?: string;
  verified: boolean;
  verificationMethod: "none" | "3ds" | "microdeposit" | "instant";
  metadata: Record<string, unknown>;
  status: "active" | "expired" | "removed";
  threeDSecureEnabled: boolean;
  threeDSecureChallenged?: boolean;
  threeDSecureVersion?: string;
  threeDSecureCryptogram?: string;
  threeDSecureEciFlag?: string;
  lastUsedAt?: Date;
  removedAt?: Date;
}

export type PaymentMethodCreationAttributes = Optional<
  PaymentMethodAttributes,
  | "id"
  | "brand"
  | "last4"
  | "expiryMonth"
  | "expiryYear"
  | "networkToken"
  | "networkTokenType"
  | "networkTokenExpiryMonth"
  | "networkTokenExpiryYear"
  | "networkTokenCryptogram"
  | "verified"
  | "verificationMethod"
  | "metadata"
  | "threeDSecureEnabled"
  | "threeDSecureChallenged"
  | "threeDSecureVersion"
  | "threeDSecureCryptogram"
  | "threeDSecureEciFlag"
  | "lastUsedAt"
  | "removedAt"
>;

PaymentMethod.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    customerId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: "users",
        key: "id",
      },
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
    },
    type: {
      type: DataTypes.ENUM("card", "bank_account", "wallet", "stellar_account"),
      allowNull: false,
    },
    token: {
      type: DataTypes.STRING(255),
      allowNull: false,
      comment: "Vault token - PAN substitute (PCI compliant)",
    },
    brand: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: "Card brand (visa, mastercard, amex, discover)",
    },
    last4: {
      type: DataTypes.STRING(4),
      allowNull: true,
      comment: "Last 4 digits of the card/account number",
    },
    expiryMonth: {
      type: DataTypes.SMALLINT,
      allowNull: true,
      comment: "Card expiry month (1-12)",
      validate: {
        min: 1,
        max: 12,
      },
    },
    expiryYear: {
      type: DataTypes.SMALLINT,
      allowNull: true,
      comment: "Card expiry year (YYYY)",
      validate: {
        min: new Date().getFullYear(),
      },
    },
    fingerprint: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
      comment: "Unique identifier for the payment method (PCI compliant)",
    },
    networkToken: {
      type: DataTypes.STRING(512),
      allowNull: true,
      comment: "Network token (Visa/Mastercard) for card payments",
    },
    networkTokenType: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: "Network token provider (visanet, mastercard-cvs, etc.)",
    },
    networkTokenExpiryMonth: {
      type: DataTypes.SMALLINT,
      allowNull: true,
      comment: "Network token expiry month",
    },
    networkTokenExpiryYear: {
      type: DataTypes.SMALLINT,
      allowNull: true,
      comment: "Network token expiry year",
    },
    networkTokenCryptogram: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: "Network token cryptogram",
    },
    verified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: "Whether the payment method has been verified",
    },
    verificationMethod: {
      type: DataTypes.ENUM("none", "3ds", "microdeposit", "instant"),
      allowNull: false,
      defaultValue: "none",
      comment: "Method used for verification",
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
      comment: "Additional metadata for the payment method",
    },
    status: {
      type: DataTypes.ENUM("active", "expired", "removed"),
      allowNull: false,
      defaultValue: "active",
      comment: "Current status of the payment method",
    },
    threeDSecureEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: "Whether 3D Secure is enabled for this payment method",
    },
    threeDSecureChallenged: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      comment: "Whether 3D Secure challenge was requested",
    },
    threeDSecureVersion: {
      type: DataTypes.STRING(20),
      allowNull: true,
      comment: "3D Secure version (e.g., 2.1.0)",
    },
    threeDSecureCryptogram: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: "3D Secure cryptogram",
    },
    threeDSecureEciFlag: {
      type: DataTypes.STRING(10),
      allowNull: true,
      comment: "3D Secure ECI flag",
    },
    lastUsedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "When this payment method was last used",
    },
    removedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "When this payment method was removed",
    },
  },
  {
    sequelize,
    modelName: "PaymentMethod",
    tableName: "payment_methods",
    timestamps: true,
    underscored: true,
    indexes: [
      {
        fields: ["customer_id"],
      },
      {
        fields: ["fingerprint"],
        unique: true,
      },
      {
        fields: ["token"],
        unique: true,
      },
      {
        fields: ["type", "status"],
      },
    ],
    comment: "PCI DSS SAQ A-EP compliant payment method vault",
  }
);

/**
 * Check if a payment method is expired
 */
export function isPaymentMethodExpired(pm: PaymentMethod): boolean {
  const now = new Date();
  if (pm.expiryYear === undefined || pm.expiryMonth === undefined) {
    return false;
  }
  const expiryDate = new Date(pm.expiryYear, pm.expiryMonth, 1);
  expiryDate.setMonth(expiryDate.getMonth() + 1); // End of month
  return expiryDate < now;
}

/**
 * Check if a payment method is usable
 */
export function isPaymentMethodUsable(pm: PaymentMethod): boolean {
  if (pm.status !== "active") {
    return false;
  }
  if (isPaymentMethodExpired(pm)) {
    return false;
  }
  return true;
}

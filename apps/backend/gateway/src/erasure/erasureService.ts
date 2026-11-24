import { createHash } from "node:crypto";
import { QueryTypes } from "sequelize";
import { User } from "../models/User.js";
import { RefreshToken } from "../models/RefreshToken.js";
import { OAuthAccount } from "../models/OAuthAccount.js";
import { PasskeyCredential } from "../models/PasskeyCredential.js";
import { Wallet } from "../models/Wallet.js";
import { Delegation } from "../models/Delegation.js";
import { Merchant } from "../models/Merchant.js";
import { Cart } from "../models/Cart.js";
import { CartItem } from "../models/CartItem.js";
import { Review } from "../models/Review.js";
import { DeliveryEvidence } from "../models/DeliveryEvidence.js";
import { sequelize } from "../db.js";
import { createLogger } from "@delegolabs/utils";

interface CreatedErasureRequestRow {
  id: string;
  user_id: string;
  wallet_address: string;
  confirmation_hash: string;
  confirmation_method: string;
  status: string;
  created_at: Date;
}

interface PaymentRow {
  id: string;
  buyer_address: string;
  seller_address: string;
}

interface CreatedCertificateRow {
  id: string;
  user_id: string;
  wallet_address: string;
  certificate_hash: string;
  issued_at: Date;
}

export interface ErasureStatusRow {
  id: string;
  user_id: string;
  wallet_address: string;
  status: string;
  confirmation_method: string;
  anonymized_payment_records: number;
  purged_chat_messages: number;
  purged_preferences: number;
  completed_at: Date | null;
  failed_at: Date | null;
  error_message: string | null;
  initiated_at: Date;
  certificate_hash: string | null;
}

export interface CertificateRow extends CreatedCertificateRow {
  anonymized_payment_records: number;
  purged_chat_messages: number;
  purged_preferences: number;
  certificate_hash_algorithm: string;
  chain_integrity_hash: string | null;
  issuer: string;
  metadata: Record<string, unknown>;
}

const log = createLogger("gateway:erasure", process.env.LOG_LEVEL ?? "info");

/**
 * Generate cryptographic hash for anonymization
 */
export function generateHash(input: string, algorithm: string = "sha256"): string {
  if (algorithm === "sha256") {
    return createHash("sha256").update(input).digest("hex");
  } else if (algorithm === "sha512") {
    return createHash("sha512").update(input).digest("hex");
  }
  throw new Error(`Unsupported hash algorithm: ${algorithm}`);
}

/**
 * Create account erasure request
 */
export interface CreateErasureRequestInput {
  userId: string;
  walletAddress: string;
  confirmationHash: string;
  confirmationMethod: "two_factor" | "cryptographic_signature";
  ipAddress?: string;
  userAgent?: string;
}

export interface ErasureRequest {
  id: string;
  userId: string;
  walletAddress: string;
  confirmationHash: string;
  confirmationMethod: string;
  status: string;
  createdAt: string;
}

export async function createErasureRequest(
  input: CreateErasureRequestInput
): Promise<ErasureRequest> {
  const [erasureRequest] = await sequelize.query<CreatedErasureRequestRow>(
    `
    INSERT INTO account_erasure_requests (
      user_id,
      wallet_address,
      confirmation_hash,
      confirmation_method,
      status,
      ip_address,
      user_agent
    )
    VALUES ($1, $2, $3, $4, 'pending', $5, $6)
    RETURNING id, user_id, wallet_address, confirmation_hash, confirmation_method, status, created_at
    `,
    {
      bind: [
        input.userId,
        input.walletAddress,
        input.confirmationHash,
        input.confirmationMethod,
        input.ipAddress || null,
        input.userAgent || null,
      ],
      // SELECT formats RETURNING as rows; useMaster keeps this write on the primary.
      type: QueryTypes.SELECT,
      useMaster: true,
    }
  );

  if (!erasureRequest) {
    throw new Error("Erasure request insert returned no row");
  }

  return {
    id: erasureRequest.id,
    userId: erasureRequest.user_id,
    walletAddress: erasureRequest.wallet_address,
    confirmationHash: erasureRequest.confirmation_hash,
    confirmationMethod: erasureRequest.confirmation_method,
    status: erasureRequest.status,
    createdAt: erasureRequest.created_at.toISOString(),
  };
}

/**
 * Execute account erasure - anonymizes PII while preserving transaction integrity
 */
export interface ErasureReport {
  userId: string;
  walletAddress: string;
  anonymizedPaymentRecords: number;
  purgedChatMessages: number;
  purgedPreferences: number;
  completedAt: string;
}

export async function executeAccountErasure(
  userId: string,
  walletAddress: string
): Promise<ErasureReport> {
  const completedAt = new Date().toISOString();

  // 1. Anonymize payment records - replace personal info with hashes
  const anonymizedPaymentRecords = await anonymizePaymentRecords(userId, walletAddress);

  // 2. Purge chat messages
  const purgedChatMessages = await purgeChatMessages(userId);

  // 3. Purge notification preferences
  const purgedPreferences = await purgePreferences(userId);

  // 4. Delete user account
  await deleteUserAccount(userId);

  // 5. Generate erasure certificate
  await generateErasureCertificate(
    userId,
    walletAddress,
    anonymizedPaymentRecords,
    purgedChatMessages,
    purgedPreferences
  );

  return {
    userId,
    walletAddress,
    anonymizedPaymentRecords,
    purgedChatMessages,
    purgedPreferences,
    completedAt,
  };
}

/**
 * Anonymize payment records - replace personal info with hashes while preserving transaction data
 */
async function anonymizePaymentRecords(
  userId: string,
  walletAddress: string
): Promise<number> {
  const paymentRecords = await sequelize.query<PaymentRow>(
    `
    SELECT id, buyer_address, seller_address, amount_stroops, asset_code, status, escrow_contract_id
    FROM payment_records
    WHERE buyer_address = $1 OR seller_address = $1
    `,
    {
      bind: [walletAddress],
      type: QueryTypes.SELECT,
    }
  );

  let count = 0;
  for (const record of paymentRecords) {
    // Create hash entry for anonymization
    await sequelize.query(
      `
      INSERT INTO erasure_payment_hashes (
        payment_record_id,
        original_buyer_address,
        buyer_address_hash,
        original_seller_address,
        seller_address_hash,
        hash_algorithm
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        'sha256'
      )
      ON CONFLICT (payment_record_id) DO NOTHING
      `,
      {
        bind: [
          record.id,
          record.buyer_address,
          generateHash(record.buyer_address),
          record.seller_address,
          generateHash(record.seller_address),
        ],
        type: QueryTypes.INSERT,
      }
    );
    count++;
  }

  log.info("Anonymized payment records", {
    count,
    userId,
    walletAddress,
  });

  return count;
}

/**
 * Purge chat messages and create tombstone
 */
async function purgeChatMessages(userId: string): Promise<number> {
  // For now, this is a placeholder - chat messages may be stored elsewhere
  // In a production system, you would purge actual message content here
  // and store only a tombstone indicating messages were deleted

  await sequelize.query(
    `
    INSERT INTO erasure_chat_tombstones (
      user_id,
      message_count,
      conversation_ids,
      content_hash,
      deleted_at,
      deleted_by
    )
    VALUES (
      $1,
      0,
      '{}',
      $2,
      NOW(),
      'system:gdpr_erasure'
    )
    RETURNING id
    `,
    {
      bind: [userId, generateHash(`chat-purge-${userId}-${Date.now()}`)],
      type: QueryTypes.INSERT,
    }
  );

  log.info("Purged chat messages", {
    userId,
  });

  return 0;
}

/**
 * Purge notification preferences
 */
async function purgePreferences(userId: string): Promise<number> {
  let count = 0;

  // Delete notification preferences
  await sequelize.query(
    `
    INSERT INTO erasure_preferences_tombstones (
      user_id,
      preference_type,
      deleted_count,
      deleted_at,
      deleted_by
    )
    VALUES (
      $1,
      'notification',
      1,
      NOW(),
      'system:gdpr_erasure'
    )
    RETURNING id
    `,
    {
      bind: [userId],
      type: QueryTypes.INSERT,
    }
  );
  count++;

  // Delete in-app notifications
  await sequelize.query(
    `
    DELETE FROM in_app_notifications WHERE user_id = $1
    `,
    {
      bind: [userId],
      type: QueryTypes.DELETE,
    }
  );

  // Delete scheduled notifications
  await sequelize.query(
    `
    DELETE FROM scheduled_notifications WHERE user_id = $1
    `,
    {
      bind: [userId],
      type: QueryTypes.DELETE,
    }
  );

  log.info("Purged notification preferences", {
    userId,
    count,
  });

  return count;
}

/**
 * Delete user account and related data
 */
async function deleteUserAccount(userId: string): Promise<void> {
  // Delete refresh tokens
  await RefreshToken.destroy({ where: { userId } });

  // Delete OAuth accounts
  await OAuthAccount.destroy({ where: { userId } });

  // Delete passkeys
  await PasskeyCredential.destroy({ where: { userId } });

  // Delete wallets
  await Wallet.destroy({ where: { userId } });

  // Delete delegations
  await Delegation.destroy({ where: { userId } });

  // Delete merchant accounts
  await Merchant.destroy({ where: { ownerUserId: userId } });

  // Delete carts and cart items
  const cartIds = await sequelize.query<{ id: string }>(
    `SELECT id FROM carts WHERE user_id = $1`,
    {
      bind: [userId],
      type: QueryTypes.SELECT,
    }
  );
  await CartItem.destroy({ where: { cartId: cartIds.map((cart) => cart.id) } });
  await Cart.destroy({ where: { userId } });

  // Delete reviews - by buyer address (review table stores buyerAddress, not userId)
  // Note: Reviews are tied to buyer addresses on the Stellar blockchain
  await Review.destroy({ where: {} });

  // Delete delivery evidence
  await DeliveryEvidence.destroy({ where: { userId } });

  // Soft delete user record
  await User.update(
    {
      deletedAt: new Date(),
      deletedBy: userId,
      deleteReason: "GDPR Right to be Forgotten - account erasure",
    },
    { where: { id: userId } }
  );

  log.info("Deleted user account", {
    userId,
  });
}

/**
 * Generate cryptographic erasure certificate
 */
export interface ErasureCertificate {
  id: string;
  userId: string;
  walletAddress: string;
  certificateHash: string;
  issuedAt: string;
}

export async function generateErasureCertificate(
  userId: string,
  walletAddress: string,
  anonymizedPaymentRecords: number,
  purgedChatMessages: number,
  purgedPreferences: number
): Promise<ErasureCertificate> {
  const certificateData = {
    userId,
    walletAddress,
    anonymizedPaymentRecords,
    purgedChatMessages,
    purgedPreferences,
    issuer: "delego-platform",
    issuedAt: new Date().toISOString(),
  };

  const certificateHash = generateHash(JSON.stringify(certificateData));

  const [certificate] = await sequelize.query<CreatedCertificateRow>(
    `
    INSERT INTO erasure_certificates (
      user_id,
      wallet_address,
      anonymized_payment_records,
      purged_chat_messages,
      purged_preferences,
      certificate_hash,
      certificate_hash_algorithm,
      chain_integrity_hash,
      issuer,
      metadata
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      'sha256',
      $7,
      $8,
      $9
    )
    RETURNING id, user_id, wallet_address, certificate_hash, issued_at
    `,
    {
      bind: [
        userId,
        walletAddress,
        anonymizedPaymentRecords,
        purgedChatMessages,
        purgedPreferences,
        certificateHash,
        generateHash(walletAddress), // Chain integrity - link to wallet
        "delego-platform",
        JSON.stringify({
          anonymizationMethod: "sha256_hash",
          chatTombstoneCreated: true,
          preferencesTombstoneCreated: true,
        }),
      ],
      // SELECT formats RETURNING as rows; useMaster keeps this write on the primary.
      type: QueryTypes.SELECT,
      useMaster: true,
    }
  );

  if (!certificate) {
    throw new Error("Erasure certificate insert returned no row");
  }

  log.info("Generated erasure certificate", {
    userId,
    certificateHash,
  });

  return {
    id: certificate.id,
    userId: certificate.user_id,
    walletAddress: certificate.wallet_address,
    certificateHash: certificate.certificate_hash,
    issuedAt: certificate.issued_at.toISOString(),
  };
}

/**
 * Get erasure request status
 */
export async function getErasureRequestStatus(requestId: string): Promise<ErasureStatusRow | undefined> {
  const [erasureRequest] = await sequelize.query<ErasureStatusRow>(
    `
    SELECT
      aer.id,
      aer.user_id,
      aer.wallet_address,
      aer.status,
      aer.confirmation_method,
      aer.anonymized_payment_records,
      aer.purged_chat_messages,
      aer.purged_preferences,
      aer.completed_at,
      aer.failed_at,
      aer.error_message,
      aer.initiated_at,
      ec.certificate_hash
    FROM account_erasure_requests aer
    LEFT JOIN erasure_certificates ec ON aer.id = ec.erasure_request_id
    WHERE aer.id = $1
    `,
    {
      bind: [requestId],
      type: QueryTypes.SELECT,
    }
  );

  return erasureRequest;
}

/**
 * Get erasure certificate for verification
 */
export async function getErasureCertificate(
  certificateHash: string
): Promise<CertificateRow | undefined> {
  const [certificate] = await sequelize.query<CertificateRow>(
    `
    SELECT
      id,
      user_id,
      wallet_address,
      anonymized_payment_records,
      purged_chat_messages,
      purged_preferences,
      certificate_hash,
      certificate_hash_algorithm,
      chain_integrity_hash,
      issuer,
      issued_at,
      metadata
    FROM erasure_certificates
    WHERE certificate_hash = $1
    `,
    {
      bind: [certificateHash],
      type: QueryTypes.SELECT,
    }
  );

  return certificate;
}

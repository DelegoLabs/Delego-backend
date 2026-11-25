import type { IncomingMessage, ServerResponse } from "node:http";
import type { Route } from "@delegolabs/utils";
import { route, createLogger, generateId } from "@delegolabs/utils";
import { extractAuth } from "../middleware/auth.js";
import { getRequestContext } from "../middleware/requestId.js";
import {
  readJsonBody,
  InvalidJsonError,
  BodyTooLargeError,
} from "../src/request.js";
import { badRequest, forbidden, sendApiError, unauthorized } from "../src/errors.js";
import {
  createErasureRequest,
  executeAccountErasure,
  generateErasureCertificate,
  getErasureRequestStatus,
  getErasureCertificate,
} from "../src/erasure/erasureService.js";
import { sequelize } from "../db.js";

const log = createLogger("gateway:erasure", process.env.LOG_LEVEL ?? "info");

/**
 * Create erasure request endpoint
 * POST /api/v1/user/account/erasure-request
 *
 * Initiates the GDPR erasure process with two-factor/cryptographic signature confirmation
 */
export async function createErasureRequestHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const requestId = getRequestContext(req)?.requestId ?? generateId();

  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const body = await readJsonBody(req);

    // Validate required fields
    if (!body.walletAddress) {
      badRequest(res, "walletAddress is required", req);
      return;
    }

    if (!body.confirmationHash) {
      badRequest(res, "confirmationHash is required", req);
      return;
    }

    if (!body.confirmationMethod) {
      badRequest(res, "confirmationMethod is required", req);
      return;
    }

    const validMethods = ["two_factor", "cryptographic_signature"];
    if (!validMethods.includes(body.confirmationMethod)) {
      badRequest(res, `confirmationMethod must be one of: ${validMethods.join(", ")}`, req);
      return;
    }

    // Validate wallet address format (Stellar address)
    if (!/^G[A-Za-z0-9]{55}$/.test(body.walletAddress)) {
      badRequest(res, "Invalid Stellar wallet address format", req);
      return;
    }

    // Get request metadata
    const userAgent = Array.isArray(req.headers["user-agent"])
      ? req.headers["user-agent"][0]
      : req.headers["user-agent"];
    const ipAddress = Array.isArray(req.headers["x-forwarded-for"])
      ? req.headers["x-forwarded-for"][0]
      : req.headers["x-forwarded-for"];

    // Create erasure request
    const erasureRequest = await createErasureRequest({
      userId: auth.userId,
      walletAddress: body.walletAddress,
      confirmationHash: body.confirmationHash,
      confirmationMethod: body.confirmationMethod,
      ipAddress: ipAddress as string | undefined,
      userAgent: userAgent as string | undefined,
    });

    log.info("Created erasure request", {
      requestId,
      userId: auth.userId,
      request_id: erasureRequest.id,
      confirmationMethod: body.confirmationMethod,
    });

    json(res, 202, {
      data: {
        erasureRequest: {
          id: erasureRequest.id,
          userId: erasureRequest.userId,
          walletAddress: erasureRequest.walletAddress,
          status: erasureRequest.status,
          confirmationMethod: erasureRequest.confirmationMethod,
          createdAt: erasureRequest.createdAt,
        },
        message: "Erasure request created. Confirmation pending.",
      },
      error: null,
    });
  } catch (err: any) {
    log.error("Failed to create erasure request", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
    } else {
      sendApiError(res, 500, "ERASURE_REQUEST_FAILED", err.message, req);
    }
  }
}

/**
 * Confirm erasure request endpoint
 * POST /api/v1/user/account/confirm-erasure
 *
 * Confirms erasure request with second factor (OTP, wallet signature, etc.)
 */
export async function confirmErasureHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const requestId = getRequestContext(req)?.requestId ?? generateId();

  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const body = await readJsonBody(req);

    if (!body.requestId) {
      badRequest(res, "requestId is required", req);
      return;
    }

    if (!body.confirmationHash) {
      badRequest(res, "confirmationHash is required", req);
      return;
    }

    // Verify the request exists and belongs to user
    const [erasureRequest] = await sequelize.query(
      `
      SELECT id, user_id, wallet_address, status, confirmation_hash, confirmation_method
      FROM account_erasure_requests
      WHERE id = $1 AND user_id = $2
      `,
      {
        replacements: [body.requestId, auth.userId],
        type: "SELECT",
        model: null,
      }
    );

    if (!erasureRequest) {
      forbidden(res, "Erasure request not found or unauthorized", req);
      return;
    }

    if (erasureRequest.status !== "pending") {
      forbidden(res, `Erasure request already ${erasureRequest.status}`, req);
      return;
    }

    // Verify confirmation hash matches
    if (erasureRequest.confirmation_hash !== body.confirmationHash) {
      forbidden(res, "Invalid confirmation hash", req);
      return;
    }

    // Mark request as confirming and execute erasure
    await sequelize.query(
      `
      UPDATE account_erasure_requests
      SET status = 'processing',
          updated_at = NOW()
      WHERE id = $1
      `,
      {
        replacements: [body.requestId],
        type: "UPDATE",
        model: null,
      }
    );

    // Execute the erasure
    const report = await executeAccountErasure(
      erasureRequest.user_id,
      erasureRequest.wallet_address
    );

    // Mark as completed
    await sequelize.query(
      `
      UPDATE account_erasure_requests
      SET status = 'completed',
          anonymized_payment_records = $1,
          purged_chat_messages = $2,
          purged_preferences = $3,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = $4
      `,
      {
        replacements: [
          report.anonymizedPaymentRecords,
          report.purgedChatMessages,
          report.purgedPreferences,
          body.requestId,
        ],
        type: "UPDATE",
        model: null,
      }
    );

    // Generate erasure certificate
    const certificate = await generateErasureCertificate(
      erasureRequest.user_id,
      erasureRequest.wallet_address,
      report.anonymizedPaymentRecords,
      report.purgedChatMessages,
      report.purgedPreferences
    );

    log.info("Completed account erasure", {
      requestId,
      userId: auth.userId,
      request_id: body.requestId,
      report,
      certificate_hash: certificate.certificateHash,
    });

    json(res, 200, {
      data: {
        report: {
          userId: report.userId,
          walletAddress: report.walletAddress,
          anonymizedPaymentRecords: report.anonymizedPaymentRecords,
          purgedChatMessages: report.purgedChatMessages,
          purgedPreferences: report.purgedPreferences,
          completedAt: report.completedAt,
        },
        certificate: {
          userId: certificate.userId,
          walletAddress: certificate.walletAddress,
          certificateHash: certificate.certificateHash,
          issuedAt: certificate.issuedAt,
          issuer: "delego-platform",
        },
        message: "Account successfully erased. Certificate generated.",
      },
      error: null,
    });
  } catch (err: any) {
    log.error("Failed to confirm erasure", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
    } else {
      sendApiError(res, 500, "ERASURE_CONFIRMATION_FAILED", err.message, req);
    }
  }
}

/**
 * Get erasure request status endpoint
 * GET /api/v1/user/account/erasure-status/:requestId
 */
export async function getErasureStatusHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const requestId = getRequestContext(req)?.requestId ?? generateId();
  const erasureRequestId = params.requestId;

  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const erasureRequest = await getErasureRequestStatus(erasureRequestId);

    if (!erasureRequest) {
      sendApiError(res, 404, "ERASURE_REQUEST_NOT_FOUND", "Erasure request not found", req);
      return;
    }

    if (erasureRequest.user_id !== auth.userId) {
      forbidden(res, "Access denied to this erasure request", req);
      return;
    }

    json(res, 200, {
      data: {
        erasureRequest: {
          id: erasureRequest.id,
          userId: erasureRequest.user_id,
          walletAddress: erasureRequest.wallet_address,
          status: erasureRequest.status,
          confirmationMethod: erasureRequest.confirmation_method,
          anonymizedPaymentRecords: erasureRequest.anonymized_payment_records,
          purgedChatMessages: erasureRequest.purged_chat_messages,
          purgedPreferences: erasureRequest.purged_preferences,
          completedAt: erasureRequest.completed_at?.toISOString() || null,
          failedAt: erasureRequest.failed_at?.toISOString() || null,
          errorMessage: erasureRequest.error_message,
          initiatedAt: erasureRequest.initiated_at?.toISOString(),
          certificateHash: erasureRequest.certificate_hash,
        },
      },
      error: null,
    });
  } catch (err: any) {
    log.error("Failed to get erasure status", {
      requestId,
      erasureRequestId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    sendApiError(res, 500, "ERASURE_STATUS_FAILED", err.message, req);
  }
}

/**
 * Get erasure certificate endpoint
 * GET /api/v1/user/account/erasure-certificate/:certificateHash
 */
export async function getErasureCertificateHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const requestId = getRequestContext(req)?.requestId ?? generateId();
  const certificateHash = params.certificateHash;

  try {
    const certificate = await getErasureCertificate(certificateHash);

    if (!certificate) {
      sendApiError(res, 404, "CERTIFICATE_NOT_FOUND", "Erasure certificate not found", req);
      return;
    }

    json(res, 200, {
      data: {
        certificate: {
          id: certificate.id,
          userId: certificate.user_id,
          walletAddress: certificate.wallet_address,
          anonymizedPaymentRecords: certificate.anonymized_payment_records,
          purgedChatMessages: certificate.purged_chat_messages,
          purgedPreferences: certificate.purged_preferences,
          certificateHash: certificate.certificate_hash,
          certificateHashAlgorithm: certificate.certificate_hash_algorithm,
          chainIntegrityHash: certificate.chain_integrity_hash,
          issuer: certificate.issuer,
          issuedAt: certificate.issued_at?.toISOString(),
          metadata: certificate.metadata,
        },
      },
      error: null,
    });
  } catch (err: any) {
    log.error("Failed to get erasure certificate", {
      requestId,
      certificateHash,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    sendApiError(res, 500, "CERTIFICATE_RETRIEVAL_FAILED", err.message, req);
  }
}

/**
 * Delete account endpoint (direct erasure)
 * DELETE /api/v1/user/account
 *
 * Initiates GDPR-compliant account deletion with two-factor confirmation
 */
export async function deleteAccountHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const requestId = getRequestContext(req)?.requestId ?? generateId();

  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const body = await readJsonBody(req);

    // Validate required fields
    if (!body.walletAddress) {
      badRequest(res, "walletAddress is required", req);
      return;
    }

    if (!body.confirmationHash) {
      badRequest(res, "confirmationHash is required", req);
      return;
    }

    if (!body.confirmationMethod) {
      badRequest(res, "confirmationMethod is required", req);
      return;
    }

    const validMethods = ["two_factor", "cryptographic_signature"];
    if (!validMethods.includes(body.confirmationMethod)) {
      badRequest(res, `confirmationMethod must be one of: ${validMethods.join(", ")}`, req);
      return;
    }

    // Validate wallet address format
    if (!/^G[A-Za-z0-9]{55}$/.test(body.walletAddress)) {
      badRequest(res, "Invalid Stellar wallet address format", req);
      return;
    }

    // Get request metadata
    const userAgent = Array.isArray(req.headers["user-agent"])
      ? req.headers["user-agent"][0]
      : req.headers["user-agent"];
    const ipAddress = Array.isArray(req.headers["x-forwarded-for"])
      ? req.headers["x-forwarded-for"][0]
      : req.headers["x-forwarded-for"];

    // Create erasure request
    const erasureRequest = await createErasureRequest({
      userId: auth.userId,
      walletAddress: body.walletAddress,
      confirmationHash: body.confirmationHash,
      confirmationMethod: body.confirmationMethod,
      ipAddress: ipAddress as string | undefined,
      userAgent: userAgent as string | undefined,
    });

    // Immediately execute erasure
    const report = await executeAccountErasure(
      erasureRequest.userId,
      erasureRequest.walletAddress
    );

    // Update erasure request with completion data
    await sequelize.query(
      `
      UPDATE account_erasure_requests
      SET status = 'completed',
          anonymized_payment_records = $1,
          purged_chat_messages = $2,
          purged_preferences = $3,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = $4
      `,
      {
        replacements: [
          report.anonymizedPaymentRecords,
          report.purgedChatMessages,
          report.purgedPreferences,
          erasureRequest.id,
        ],
        type: "UPDATE",
        model: null,
      }
    );

    // Generate erasure certificate
    const certificate = await generateErasureCertificate(
      erasureRequest.userId,
      erasureRequest.walletAddress,
      report.anonymizedPaymentRecords,
      report.purgedChatMessages,
      report.purgedPreferences
    );

    log.info("Completed direct account deletion", {
      requestId,
      userId: auth.userId,
      request_id: erasureRequest.id,
      report,
      certificate_hash: certificate.certificateHash,
    });

    json(res, 200, {
      data: {
        message: "Account successfully erased.",
        report: {
          userId: report.userId,
          walletAddress: report.walletAddress,
          anonymizedPaymentRecords: report.anonymizedPaymentRecords,
          purgedChatMessages: report.purgedChatMessages,
          purgedPreferences: report.purgedPreferences,
          completedAt: report.completedAt,
        },
        certificate: {
          userId: certificate.userId,
          walletAddress: certificate.walletAddress,
          certificateHash: certificate.certificateHash,
          issuedAt: certificate.issuedAt,
          issuer: "delego-platform",
        },
      },
      error: null,
    });
  } catch (err: any) {
    log.error("Failed to delete account", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
    } else {
      sendApiError(res, 500, "ACCOUNT_DELETION_FAILED", err.message, req);
    }
  }
}

// Helper for JSON response
function json(
  res: ServerResponse,
  statusCode: number,
  payload: { data: any; error: any }
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}
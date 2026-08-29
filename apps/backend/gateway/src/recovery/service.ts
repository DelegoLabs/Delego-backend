import { RecoveryConfig } from "../models/RecoveryConfig.js";
import { RecoveryRequest } from "../models/RecoveryRequest.js";
import { RecoveryAuditLog } from "../models/RecoveryAuditLog.js";
import { RecoveryChallenge } from "../models/RecoveryChallenge.js";
import { User } from "../models/User.js";
import type {
  RecoveryConfig as RecoveryConfigType,
  RecoveryRequest as RecoveryRequestType,
  RecoveryAudit,
  RecoveryInitiationRequest,
  GuardianApprovalRequest,
  RecoveryCompleteRequest,
  RecoveryListRequest,
  RecoveryListResponse,
  AddGuardianRequest,
  RemoveGuardianRequest,
  UpdateGuardianRequest,
  AddEmergencyContactRequest,
  RemoveEmergencyContactRequest,
  UpdateRecoveryConfigRequest,
  RecoveryConfigResponse,
} from "@delegolabs/types";

const crypto = await import("crypto");

/**
 * Generate a unique challenge ID for recovery verification
 */
function generateChallengeId(): string {
  return `rch_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Calculate the current weight verified by approved guardians
 */
function calculateVerifiedWeight(config: RecoveryConfigType, approvedGuardianIds: string[]): number {
  let weight = 0;
  for (const guardian of config.guardians) {
    if (approvedGuardianIds.includes(guardian.id) && guardian.verified) {
      weight += guardian.weight;
    }
  }
  return weight;
}

/**
 * Check if the recovery threshold is met
 */
function isThresholdMet(config: RecoveryConfigType, approvedGuardianIds: string[]): boolean {
  return calculateVerifiedWeight(config, approvedGuardianIds) >= config.threshold;
}

/**
 * Calculate the expiration time for a recovery request
 */
function calculateExpirationTime(delayHours: number): string {
  const now = new Date();
  const expiration = new Date(now.getTime() + delayHours * 60 * 60 * 1000);
  // Add 30 minutes buffer for completion
  expiration.setMinutes(expiration.getMinutes() + 30);
  return expiration.toISOString();
}

/**
 * Get the delay end time for a recovery request
 */
function calculateDelayEndTime(delayHours: number): string {
  const now = new Date();
  return new Date(now.getTime() + delayHours * 60 * 60 * 1000).toISOString();
}

/**
 * Create recovery configuration for a user
 */
export async function createRecoveryConfig(
  accountId: string,
  config: Partial<RecoveryConfigType>
): Promise<RecoveryConfigType> {
  const existingConfig = await RecoveryConfig.findOne({ where: { accountId } });

  if (existingConfig) {
    throw new Error("Recovery configuration already exists for this account");
  }

  const defaultConfig: RecoveryConfigType = {
    guardians: [],
    threshold: 3,
    delayHours: 168, // 7 days
    emergencyContacts: [],
  };

  const finalConfig: RecoveryConfigType = {
    ...defaultConfig,
    ...config,
    guardians: config.guardians || [],
    emergencyContacts: config.emergencyContacts || [],
  };

  await RecoveryConfig.create({
    accountId,
    threshold: finalConfig.threshold,
    delayHours: finalConfig.delayHours,
    guardians: finalConfig.guardians,
    emergencyContacts: finalConfig.emergencyContacts,
    lastUpdated: new Date(),
  });

  return finalConfig;
}

/**
 * Get recovery configuration for a user
 */
export async function getRecoveryConfig(accountId: string): Promise<RecoveryConfigType | null> {
  const config = await RecoveryConfig.findOne({ where: { accountId } });
  if (!config) {
    return null;
  }

  const currentVerifiedWeight = calculateVerifiedWeight(
    config as RecoveryConfigType,
    config.guardiansApproved || []
  );

  return {
    guardians: config.guardians,
    threshold: config.threshold,
    delayHours: config.delayHours,
    emergencyContacts: config.emergencyContacts,
  };
}

/**
 * Update recovery configuration
 */
export async function updateRecoveryConfig(
  accountId: string,
  updates: UpdateRecoveryConfigRequest
): Promise<RecoveryConfigType> {
  const config = await RecoveryConfig.findOne({ where: { accountId } });
  if (!config) {
    throw new Error("Recovery configuration not found");
  }

  // Process guardian updates
  if (updates.guardians) {
    const guardians = Array.isArray(updates.guardians) ? [...config.guardians] : config.guardians;

    for (const update of updates.guardians) {
      if ("weight" in update) {
        // Update guardian weight
        const existingGuardian = guardians.find(g => g.id === update.guardianId);
        if (existingGuardian) {
          existingGuardian.weight = update.weight;
        }
      } else if ("type" in update) {
        // Add new guardian
        const newGuardian: RecoveryConfigType["guardians"][0] = {
          id: crypto.randomUUID(),
          type: update.type,
          identifier: update.identifier,
          verified: false,
          weight: update.weight,
          addedAt: new Date().toISOString(),
        };
        guardians.push(newGuardian);
      }
    }

    config.guardians = guardians;
  }

  // Process emergency contact updates
  if (updates.emergencyContacts) {
    const contacts = Array.isArray(updates.emergencyContacts) ? [...config.emergencyContacts] : config.emergencyContacts;

    for (const update of updates.emergencyContacts) {
      if ("name" in update) {
        // Add new emergency contact
        const newContact: RecoveryConfigType["emergencyContacts"][0] = {
          id: crypto.randomUUID(),
          name: update.name,
          email: update.email,
          phone: update.phone,
          verified: false,
          addedAt: new Date().toISOString(),
        };
        contacts.push(newContact);
      }
    }

    config.emergencyContacts = contacts;
  }

  // Update threshold and delay hours if provided
  if (updates.threshold !== undefined) {
    config.threshold = updates.threshold;
  }
  if (updates.delayHours !== undefined) {
    config.delayHours = updates.delayHours;
  }

  config.lastUpdated = new Date();
  await config.save();

  return config as RecoveryConfigType;
}

/**
 * Add guardian to recovery config
 */
export async function addGuardian(
  accountId: string,
  request: AddGuardianRequest
): Promise<RecoveryConfigType> {
  const config = await RecoveryConfig.findOne({ where: { accountId } });
  if (!config) {
    throw new Error("Recovery configuration not found");
  }

  const newGuardian: RecoveryConfigType["guardians"][0] = {
    id: crypto.randomUUID(),
    type: request.type,
    identifier: request.identifier,
    verified: false,
    weight: request.weight,
    addedAt: new Date().toISOString(),
  };

  config.guardians.push(newGuardian);
  config.lastUpdated = new Date();
  await config.save();

  return config as RecoveryConfigType;
}

/**
 * Remove guardian from recovery config
 */
export async function removeGuardian(
  accountId: string,
  request: RemoveGuardianRequest
): Promise<RecoveryConfigType> {
  const config = await RecoveryConfig.findOne({ where: { accountId } });
  if (!config) {
    throw new Error("Recovery configuration not found");
  }

  config.guardians = config.guardians.filter(g => g.id !== request.guardianId);
  config.lastUpdated = new Date();
  await config.save();

  // Log removal event
  await RecoveryAuditLog.create({
    requestId: "", // No active recovery
    action: "cancelled",
    actor: accountId,
    timestamp: new Date(),
    details: {
      action: "guardian_removed",
      guardianId: request.guardianId,
      reason: request.reason,
    },
  });

  return config as RecoveryConfigType;
}

/**
 * Update guardian verification status
 */
export async function verifyGuardian(
  accountId: string,
  guardianId: string,
  verified: boolean
): Promise<RecoveryConfigType> {
  const config = await RecoveryConfig.findOne({ where: { accountId } });
  if (!config) {
    throw new Error("Recovery configuration not found");
  }

  const guardian = config.guardians.find(g => g.id === guardianId);
  if (!guardian) {
    throw new Error("Guardian not found");
  }

  guardian.verified = verified;
  config.lastUpdated = new Date();
  await config.save();

  return config as RecoveryConfigType;
}

/**
 * Add emergency contact
 */
export async function addEmergencyContact(
  accountId: string,
  request: AddEmergencyContactRequest
): Promise<RecoveryConfigType> {
  const config = await RecoveryConfig.findOne({ where: { accountId } });
  if (!config) {
    throw new Error("Recovery configuration not found");
  }

  const newContact: RecoveryConfigType["emergencyContacts"][0] = {
    id: crypto.randomUUID(),
    name: request.name,
    email: request.email,
    phone: request.phone,
    verified: false,
    addedAt: new Date().toISOString(),
  };

  config.emergencyContacts.push(newContact);
  config.lastUpdated = new Date();
  await config.save();

  return config as RecoveryConfigType;
}

/**
 * Remove emergency contact
 */
export async function removeEmergencyContact(
  accountId: string,
  request: RemoveEmergencyContactRequest
): Promise<RecoveryConfigType> {
  const config = await RecoveryConfig.findOne({ where: { accountId } });
  if (!config) {
    throw new Error("Recovery configuration not found");
  }

  config.emergencyContacts = config.emergencyContacts.filter(c => c.id !== request.contactId);
  config.lastUpdated = new Date();
  await config.save();

  return config as RecoveryConfigType;
}

/**
 * Initiate a recovery request
 */
export async function initiateRecovery(
  accountId: string,
  initiatedBy: string,
  request: RecoveryInitiationRequest
): Promise<RecoveryRequestType> {
  const config = await RecoveryConfig.findOne({ where: { accountId } });
  if (!config) {
    throw new Error("Recovery configuration not found");
  }

  // Check if there's an existing active recovery
  const existingRecovery = await RecoveryRequest.findOne({
    where: {
      accountId,
      status: { [RecoveryRequest.Sequelize.Op.notIn]: ["completed", "cancelled"] },
    },
  });

  if (existingRecovery) {
    throw new Error("An active recovery is already in progress");
  }

  const recoveryRequest = await RecoveryRequest.create({
    accountId,
    initiatedBy,
    type: request.type,
    status: "pending",
    guardiansApproved: [],
    guardiansRejected: [],
    delayEndsAt: calculateDelayEndTime(config.delayHours),
    initiatedAt: new Date().toISOString(),
    expiresAt: calculateExpirationTime(config.delayHours),
    metadata: {
      initiatedBy,
      type: request.type,
      requestedAt: new Date().toISOString(),
    },
  });

  // Log initiation event
  await RecoveryAuditLog.create({
    requestId: recoveryRequest.id,
    action: "initiated",
    actor: initiatedBy,
    timestamp: new Date(),
    details: {
      type: request.type,
      initiatedBy,
      delayHours: config.delayHours,
      threshold: config.threshold,
    },
  });

  // Create verification challenges for guardians (for social recovery)
  if (request.type === "social" && request.guardianIds) {
    for (const guardianId of request.guardianIds) {
      const guardian = config.guardians.find(g => g.id === guardianId);
      if (guardian && guardian.verified) {
        const challengeId = generateChallengeId();
        const challenge = RecoveryChallenge.build({
          requestId: recoveryRequest.id,
          guardianId,
          method: guardian.type === "wallet" ? "wallet_signature" : "email",
          challengeId,
          expiresAt: calculateExpirationTime(config.delayHours),
          maxAttempts: 3,
        });
        await challenge.save();

        // Store challenge info in recovery request metadata
        const metadata = recoveryRequest.metadata || {};
        if (!metadata.challenges) metadata.challenges = {};
        metadata.challenges[guardianId] = {
          challengeId,
          method: challenge.method,
          expiresAt: challenge.expiresAt,
        };
        recoveryRequest.metadata = metadata;
      }
    }
    await recoveryRequest.save();
  }

  // Notify emergency contacts (for emergency recovery)
  if (request.type === "emergency" && (request.email || request.phoneNumber)) {
    // In a real implementation, send notification to emergency contacts
    // This would typically use the notification service
  }

  return recoveryRequest as RecoveryRequestType;
}

/**
 * Approve or reject a recovery request
 */
export async function processGuardianApproval(
  recoveryId: string,
  guardianId: string,
  request: GuardianApprovalRequest
): Promise<RecoveryRequestType> {
  const recovery = await RecoveryRequest.findByPk(recoveryId);
  if (!recovery) {
    throw new Error("Recovery request not found");
  }

  // Check if guardian is authorized
  const config = await RecoveryConfig.findOne({ where: { accountId: recovery.accountId } });
  if (!config) {
    throw new Error("Recovery configuration not found");
  }

  const guardian = config.guardians.find(g => g.id === guardianId);
  if (!guardian) {
    throw new Error("Guardian not found in recovery configuration");
  }

  if (!guardian.verified) {
    throw new Error("Guardian must be verified before approving recovery");
  }

  // Check if already approved or rejected
  if (recovery.guardiansApproved.includes(guardianId)) {
    throw new Error("Guardian has already approved this recovery");
  }
  if (recovery.guardiansRejected.includes(guardianId)) {
    throw new Error("Guardian has already rejected this recovery");
  }

  // Verify the challenge if provided
  if (request.verificationCode || request.walletSignature || request.hardwareSignature) {
    const challenge = await RecoveryChallenge.findOne({
      where: {
        requestId: recoveryId,
        guardianId,
        verifiedAt: null,
        rejectedAt: null,
      },
    });

    if (challenge) {
      // In a real implementation, verify the code or signature
      // For now, assume successful verification
      challenge.verifiedAt = new Date().toISOString();
      challenge.completedAt = new Date().toISOString();
      await challenge.save();
    }
  }

  // Approve the recovery
  recovery.guardiansApproved.push(guardianId);
  await recovery.save();

  // Log approval event
  await RecoveryAuditLog.create({
    requestId: recoveryId,
    action: "guardian_approved",
    actor: guardianId,
    timestamp: new Date(),
    details: {
      guardianId,
      currentApprovals: recovery.guardiansApproved.length,
      totalThreshold: config.threshold,
    },
  });

  // Check if threshold is met
  if (isThresholdMet(config as RecoveryConfigType, recovery.guardiansApproved)) {
    recovery.status = "delayed";
    recovery.delayEndsAt = calculateDelayEndTime(config.delayHours);
    await recovery.save();

    // Log threshold met event
    await RecoveryAuditLog.create({
      requestId: recoveryId,
      action: "guardian_approved",
      actor: "system",
      timestamp: new Date(),
      details: {
        action: "threshold_met",
        totalApprovals: recovery.guardiansApproved.length,
        threshold: config.threshold,
        statusChangedTo: "delayed",
      },
    });
  }

  return recovery as RecoveryRequestType;
}

/**
 * Reject a recovery request
 */
export async function rejectRecovery(
  recoveryId: string,
  guardianId: string,
  reason?: string
): Promise<RecoveryRequestType> {
  const recovery = await RecoveryRequest.findByPk(recoveryId);
  if (!recovery) {
    throw new Error("Recovery request not found");
  }

  // Check if guardian is authorized
  const config = await RecoveryConfig.findOne({ where: { accountId: recovery.accountId } });
  if (!config) {
    throw new Error("Recovery configuration not found");
  }

  const guardian = config.guardians.find(g => g.id === guardianId);
  if (!guardian) {
    throw new Error("Guardian not found in recovery configuration");
  }

  if (recovery.guardiansRejected.includes(guardianId)) {
    throw new Error("Guardian has already rejected this recovery");
  }

  // Reject the recovery
  recovery.guardiansRejected.push(guardianId);
  await recovery.save();

  // Log rejection event
  await RecoveryAuditLog.create({
    requestId: recoveryId,
    action: "guardian_rejected",
    actor: guardianId,
    timestamp: new Date(),
    details: {
      guardianId,
      reason,
    },
  });

  return recovery as RecoveryRequestType;
}

/**
 * Cancel a recovery request
 */
export async function cancelRecovery(recoveryId: string, accountId: string, reason: string): Promise<void> {
  const recovery = await RecoveryRequest.findByPk(recoveryId);
  if (!recovery) {
    throw new Error("Recovery request not found");
  }

  if (recovery.accountId !== accountId) {
    throw new Error("Cannot cancel recovery for another account");
  }

  if (recovery.status === "completed" || recovery.status === "cancelled") {
    throw new Error("Recovery is already completed or cancelled");
  }

  recovery.status = "cancelled";
  recovery.cancelledAt = new Date().toISOString();
  await recovery.save();

  // Log cancellation event
  await RecoveryAuditLog.create({
    requestId: recoveryId,
    action: "cancelled",
    actor: accountId,
    timestamp: new Date(),
    details: {
      reason,
      cancelledBy: accountId,
    },
  });
}

/**
 * Complete a recovery request (after delay has expired)
 */
export async function completeRecovery(
  recoveryId: string,
  accountId: string,
  request: RecoveryCompleteRequest
): Promise<RecoveryRequestType> {
  const recovery = await RecoveryRequest.findByPk(recoveryId);
  if (!recovery) {
    throw new Error("Recovery request not found");
  }

  if (recovery.accountId !== accountId) {
    throw new Error("Cannot complete recovery for another account");
  }

  if (recovery.status !== "delayed") {
    throw new Error("Recovery must be in delayed status before completion");
  }

  // Check if delay has expired
  const delayEndsAt = new Date(recovery.delayEndsAt || 0);
  if (delayEndsAt > new Date()) {
    throw new Error("Recovery delay has not yet expired");
  }

  // Verify verification code if provided
  if (request.verificationCode) {
    // In a real implementation, verify the code
    // This would check against the stored challenge
  }

  // Generate new credentials
  const newPublicKey = request.newStellarAddress || crypto.randomUUID();
  recovery.newCredentials = {
    publicKey: newPublicKey,
    newStellarAddress: newPublicKey,
  };
  recovery.status = "completed";
  recovery.completedAt = new Date().toISOString();
  await recovery.save();

  // Log completion event
  await RecoveryAuditLog.create({
    requestId: recoveryId,
    action: "completed",
    actor: accountId,
    timestamp: new Date(),
    details: {
      newPublicKey,
      completionTime: new Date().toISOString(),
      recoveryDurationMinutes: Math.round((new Date().getTime() - new Date(recovery.initiatedAt).getTime()) / 60000),
    },
  });

  return recovery as RecoveryRequestType;
}

/**
 * List recovery requests for an account
 */
export async function listRecoveryRequests(
  accountId: string,
  request: RecoveryListRequest
): Promise<RecoveryListResponse> {
  const { status, page = 1, limit = 20 } = request;

  const where: any = { accountId };
  if (status) {
    where.status = status;
  }

  const offset = (page - 1) * limit;

  const { count, rows } = await RecoveryRequest.findAndCountAll({
    where,
    limit,
    offset,
    order: [["initiatedAt", "DESC"]],
  });

  const totalPages = Math.ceil(count / limit);

  return {
    recoveryRequests: rows as RecoveryRequestType[],
    totalCount: count,
    page,
    limit,
    totalPages,
  };
}

/**
 * Get a specific recovery request
 */
export async function getRecoveryRequest(
  recoveryId: string,
  accountId: string
): Promise<RecoveryRequestType | null> {
  const recovery = await RecoveryRequest.findByPk(recoveryId);
  if (!recovery || recovery.accountId !== accountId) {
    return null;
  }

  return recovery as RecoveryRequestType;
}

/**
 * Get recovery progress
 */
export async function getRecoveryProgress(accountId: string): Promise<RecoveryConfigResponse | null> {
  const config = await RecoveryConfig.findOne({ where: { accountId } });
  if (!config) {
    return null;
  }

  // Get active recovery requests
  const activeRecoveries = await RecoveryRequest.findAll({
    where: {
      accountId,
      status: { [RecoveryRequest.Sequelize.Op.notIn]: ["completed", "cancelled"] },
    },
  });

  const activeRecovery = activeRecoveries.length > 0 ? activeRecoveries[0] : null;

  // Calculate verification progress
  let weightVerified = 0;
  let guardiansVerified = 0;

  for (const guardian of config.guardians) {
    if (guardian.verified) {
      guardiansVerified++;
      weightVerified += guardian.weight;
    }
  }

  // Calculate next recovery time (when current delay expires)
  let nextRecoveryTime: string | undefined;
  if (activeRecovery && activeRecovery.status === "delayed" && activeRecovery.delayEndsAt) {
    nextRecoveryTime = activeRecovery.delayEndsAt;
  }

  return {
    guardians: config.guardians,
    threshold: config.threshold,
    delayHours: config.delayHours,
    emergencyContacts: config.emergencyContacts,
    currentProgress: {
      guardiansVerified,
      totalGuardians: config.guardians.length,
      weightVerified,
      weightThreshold: config.threshold,
    },
    nextRecoveryTime,
  };
}

/**
 * Check if account is recoverable
 */
export async function isRecoverable(accountId: string): Promise<boolean> {
  const config = await RecoveryConfig.findOne({ where: { accountId } });
  if (!config) {
    return false;
  }

  // Must have at least one verified guardian
  const verifiedGuardians = config.guardians.filter(g => g.verified);
  if (verifiedGuardians.length === 0) {
    return false;
  }

  // Weight of verified guardians must meet threshold
  let totalWeight = 0;
  for (const guardian of verifiedGuardians) {
    totalWeight += guardian.weight;
  }

  return totalWeight >= config.threshold;
}

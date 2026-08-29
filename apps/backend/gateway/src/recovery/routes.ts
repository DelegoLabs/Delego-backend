import type { RouteHandler } from "@delegolabs/utils";
import { json } from "@delegolabs/utils";
import { internalError, notFound, validationError, success } from "../errors.js";
import { getAuthenticatedUserContext } from "../middleware/auth.js";
import {
  createRecoveryConfig,
  getRecoveryConfig,
  updateRecoveryConfig,
  addGuardian,
  removeGuardian,
  verifyGuardian,
  addEmergencyContact,
  removeEmergencyContact,
  initiateRecovery,
  processGuardianApproval,
  rejectRecovery,
  cancelRecovery,
  completeRecovery,
  listRecoveryRequests,
  getRecoveryRequest,
  getRecoveryProgress,
  isRecoverable,
} from "./service.js";
import type {
  RecoveryInitiationRequest,
  GuardianApprovalRequest,
  RecoveryCompleteRequest,
  RecoveryListRequest,
  AddGuardianRequest,
  RemoveGuardianRequest,
  UpdateGuardianRequest,
  AddEmergencyContactRequest,
  RemoveEmergencyContactRequest,
  UpdateRecoveryConfigRequest,
} from "@delegolabs/types";

/**
 * Get recovery configuration handler
 */
export const getRecoveryConfigHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const config = await getRecoveryConfig(userContext.userId);
    if (!config) {
      return notFound(res, "Recovery configuration not found", req);
    }

    return success(res, config, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Create recovery configuration handler
 */
export const createRecoveryConfigHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const body: UpdateRecoveryConfigRequest = req.body;

    // Must have at least one verified guardian with sufficient weight
    if (body.guardians && body.guardians.length > 0) {
      const totalWeight = body.guardians.reduce((sum, g) => {
        if ("weight" in g) return sum + g.weight;
        return sum;
      }, 0);
      if (totalWeight < (body.threshold || 3)) {
        return validationError(
          res,
          "Total guardian weight must meet or exceed threshold",
          req,
          { totalWeight, threshold: body.threshold || 3 }
        );
      }
    }

    const config = await createRecoveryConfig(userContext.userId, body);

    return success(res, config, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Update recovery configuration handler
 */
export const updateRecoveryConfigHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { accountId } = req.params as { accountId: string };
    if (accountId !== userContext.userId) {
      return notFound(res, "Cannot update recovery for another account", req);
    }

    const body: UpdateRecoveryConfigRequest = req.body;

    const config = await updateRecoveryConfig(accountId, body);

    return success(res, config, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Add guardian handler
 */
export const addGuardianHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { accountId } = req.params as { accountId: string };
    if (accountId !== userContext.userId) {
      return notFound(res, "Cannot add guardian for another account", req);
    }

    const body: AddGuardianRequest = req.body;

    const config = await addGuardian(accountId, body);

    return success(res, config, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Remove guardian handler
 */
export const removeGuardianHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { accountId, guardianId } = req.params as { accountId: string; guardianId: string };
    if (accountId !== userContext.userId) {
      return notFound(res, "Cannot remove guardian for another account", req);
    }

    const body: RemoveGuardianRequest = req.body;

    const config = await removeGuardian(accountId, { ...body, guardianId });

    return success(res, config, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Verify guardian handler
 */
export const verifyGuardianHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { accountId, guardianId } = req.params as { accountId: string; guardianId: string };
    if (accountId !== userContext.userId) {
      return notFound(res, "Cannot verify guardian for another account", req);
    }

    const { verified } = req.body as { verified: boolean };

    const config = await verifyGuardian(accountId, guardianId, verified);

    return success(res, config, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Add emergency contact handler
 */
export const addEmergencyContactHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { accountId } = req.params as { accountId: string };
    if (accountId !== userContext.userId) {
      return notFound(res, "Cannot add emergency contact for another account", req);
    }

    const body: AddEmergencyContactRequest = req.body;

    const config = await addEmergencyContact(accountId, body);

    return success(res, config, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Remove emergency contact handler
 */
export const removeEmergencyContactHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { accountId, contactId } = req.params as { accountId: string; contactId: string };
    if (accountId !== userContext.userId) {
      return notFound(res, "Cannot remove emergency contact for another account", req);
    }

    const body: RemoveEmergencyContactRequest = req.body;

    const config = await removeEmergencyContact(accountId, { ...body, contactId });

    return success(res, config, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Initiate recovery handler
 */
export const initiateRecoveryHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { accountId } = req.params as { accountId: string };
    if (accountId !== userContext.userId) {
      return notFound(res, "Cannot initiate recovery for another account", req);
    }

    const body: RecoveryInitiationRequest = req.body;

    const recovery = await initiateRecovery(accountId, userContext.userId, body);

    return success(res, recovery, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Process guardian approval handler
 */
export const processGuardianApprovalHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { recoveryId } = req.params as { recoveryId: string };

    const body: GuardianApprovalRequest = req.body;

    const recovery = await processGuardianApproval(recoveryId, userContext.userId, body);

    return success(res, recovery, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Reject recovery handler
 */
export const rejectRecoveryHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { recoveryId } = req.params as { recoveryId: string };

    const { reason } = req.body as { reason?: string };

    const recovery = await rejectRecovery(recoveryId, userContext.userId, reason);

    return success(res, recovery, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Cancel recovery handler
 */
export const cancelRecoveryHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { recoveryId } = req.params as { recoveryId: string };

    const { reason } = req.body as { reason: string };

    await cancelRecovery(recoveryId, userContext.userId, reason);

    return success(res, { success: true }, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Complete recovery handler
 */
export const completeRecoveryHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { recoveryId } = req.params as { recoveryId: string };

    const body: RecoveryCompleteRequest = req.body;

    const recovery = await completeRecovery(recoveryId, userContext.userId, body);

    return success(res, recovery, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * List recovery requests handler
 */
export const listRecoveryRequestsHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { accountId } = req.params as { accountId: string };
    if (accountId !== userContext.userId) {
      return notFound(res, "Cannot list recovery requests for another account", req);
    }

    const query: RecoveryListRequest = {
      accountId,
      status: req.query?.status as any,
      page: Number(req.query?.page) || 1,
      limit: Number(req.query?.limit) || 20,
    };

    const result = await listRecoveryRequests(query);

    return success(res, result, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Get recovery progress handler
 */
export const getRecoveryProgressHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const progress = await getRecoveryProgress(userContext.userId);

    if (!progress) {
      return notFound(res, "Recovery configuration not found", req);
    }

    return success(res, progress, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

/**
 * Check if account is recoverable handler
 */
export const isRecoverableHandler: RouteHandler = async (req, res) => {
  try {
    const userContext = getAuthenticatedUserContext(req);
    if (!userContext) {
      return notFound(res, "User not authenticated", req);
    }

    const { accountId } = req.params as { accountId: string };
    if (accountId !== userContext.userId) {
      return notFound(res, "Cannot check recoverability for another account", req);
    }

    const recoverable = await isRecoverable(accountId);

    return success(res, { recoverable }, req);
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown error");
    return internalError(res, error.message, req, { details: error.stack });
  }
};

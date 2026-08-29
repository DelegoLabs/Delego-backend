import type { Route } from "@delegolabs/utils";
import { route } from "@delegolabs/utils";
import {
  getRecoveryConfigHandler,
  createRecoveryConfigHandler,
  updateRecoveryConfigHandler,
  addGuardianHandler,
  removeGuardianHandler,
  verifyGuardianHandler,
  addEmergencyContactHandler,
  removeEmergencyContactHandler,
  initiateRecoveryHandler,
  processGuardianApprovalHandler,
  rejectRecoveryHandler,
  cancelRecoveryHandler,
  completeRecoveryHandler,
  listRecoveryRequestsHandler,
  getRecoveryProgressHandler,
  isRecoverableHandler,
} from "../src/recovery/routes.js";

/**
 * Register recovery routes
 */
export function registerRecoveryRoutes(): Route[] {
  return [
    // Configuration routes
    route("GET", "/api/v1/recovery/config", getRecoveryConfigHandler),
    route("POST", "/api/v1/recovery/config", createRecoveryConfigHandler),
    route("PATCH", "/api/v1/recovery/config", updateRecoveryConfigHandler),

    // Guardian management routes
    route("POST", "/api/v1/recovery/guardians", addGuardianHandler),
    route("DELETE", "/api/v1/recovery/guardians/:guardianId", removeGuardianHandler),
    route("PATCH", "/api/v1/recovery/guardians/:guardianId/verify", verifyGuardianHandler),

    // Emergency contact routes
    route("POST", "/api/v1/recovery/emergency-contacts", addEmergencyContactHandler),
    route("DELETE", "/api/v1/recovery/emergency-contacts/:contactId", removeEmergencyContactHandler),

    // Recovery request routes
    route("POST", "/api/v1/recovery/:accountId/initiate", initiateRecoveryHandler),
    route("POST", "/api/v1/recovery/:recoveryId/approve", processGuardianApprovalHandler),
    route("POST", "/api/v1/recovery/:recoveryId/reject", rejectRecoveryHandler),
    route("POST", "/api/v1/recovery/:recoveryId/cancel", cancelRecoveryHandler),
    route("POST", "/api/v1/recovery/:recoveryId/complete", completeRecoveryHandler),
    route("GET", "/api/v1/recovery/:accountId/requests", listRecoveryRequestsHandler),
    route("GET", "/api/v1/recovery/:accountId/progress", getRecoveryProgressHandler),
    route("GET", "/api/v1/recovery/:accountId/verifiable", isRecoverableHandler),
  ];
}

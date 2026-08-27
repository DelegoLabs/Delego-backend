/**
 * Social Guardian Account Recovery — HTTP routes
 * Issue #43
 *
 * POST   /recovery/guardians                           – add guardian
 * POST   /recovery/guardians/:guardianId/verify        – verify guardian
 * DELETE /recovery/guardians/:guardianId               – remove guardian
 * GET    /recovery/guardians/:walletAddress            – list guardians
 * POST   /recovery/requests                            – initiate recovery
 * GET    /recovery/requests/:requestId                 – get recovery request
 * POST   /recovery/requests/:requestId/approve         – guardian approval
 * POST   /recovery/admin/disable                       – emergency disable
 * POST   /recovery/admin/enable                        – re-enable recovery
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { route, json, type Route } from "@delegolabs/utils";
import {
  addGuardian,
  verifyGuardian,
  removeGuardian,
  listGuardians,
  initiateRecovery,
  approveRecovery,
  getRecoveryRequest,
  disableRecovery,
  enableRecovery,
} from "./guardianRecovery.js";

async function readBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as T) : ({} as T));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function handleError(res: ServerResponse, err: unknown): void {
  const message = err instanceof Error ? err.message : "Unknown error";
  const status = message.toLowerCase().includes("not found")
    ? 404
    : message.toLowerCase().includes("rate limit")
      ? 429
      : 400;
  json(res, status, { data: null, error: { code: "RECOVERY_ERROR", message } });
}

export function registerRecoveryRoutes(): Route[] {
  return [
    // Add guardian
    route("POST", "/recovery/guardians", async (req, res) => {
      try {
        const body = await readBody(req);
        const guardian = await addGuardian(
          body as Parameters<typeof addGuardian>[0],
        );
        json(res, 201, { data: guardian, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // Verify guardian
    route(
      "POST",
      "/recovery/guardians/:guardianId/verify",
      async (req, res, params) => {
        try {
          const { verificationCode } = await readBody<{
            verificationCode: string;
          }>(req);
          const guardian = await verifyGuardian(
            params.guardianId,
            verificationCode,
          );
          json(res, 200, { data: guardian, error: null });
        } catch (err) {
          handleError(res, err);
        }
      },
    ),

    // Remove guardian
    route(
      "DELETE",
      "/recovery/guardians/:guardianId",
      async (_req, res, params) => {
        try {
          await removeGuardian(params.guardianId);
          json(res, 204, { data: null, error: null });
        } catch (err) {
          handleError(res, err);
        }
      },
    ),

    // List guardians
    route(
      "GET",
      "/recovery/guardians/:walletAddress",
      async (_req, res, params) => {
        try {
          const guardians = await listGuardians(params.walletAddress);
          json(res, 200, { data: guardians, error: null });
        } catch (err) {
          handleError(res, err);
        }
      },
    ),

    // Initiate recovery
    route("POST", "/recovery/requests", async (req, res) => {
      try {
        const body = await readBody(req);
        const result = await initiateRecovery(
          body as Parameters<typeof initiateRecovery>[0],
        );
        json(res, 201, { data: result, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // Get recovery request
    route("GET", "/recovery/requests/:requestId", async (_req, res, params) => {
      try {
        const req_ = await getRecoveryRequest(params.requestId);
        json(res, 200, { data: req_, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // Approve recovery
    route(
      "POST",
      "/recovery/requests/:requestId/approve",
      async (req, res, params) => {
        try {
          const body = await readBody(req);
          const result = await approveRecovery(
            params.requestId,
            body as Parameters<typeof approveRecovery>[1],
          );
          json(res, 200, { data: result, error: null });
        } catch (err) {
          handleError(res, err);
        }
      },
    ),

    // Emergency disable
    route("POST", "/recovery/admin/disable", async (_req, res) => {
      try {
        disableRecovery();
        json(res, 200, { data: { enabled: false }, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // Re-enable
    route("POST", "/recovery/admin/enable", async (_req, res) => {
      try {
        enableRecovery();
        json(res, 200, { data: { enabled: true }, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),
  ];
}

/**
 * Proposal routes — Issue #265
 * POST /proposals        — create a proposal
 * GET  /proposals/:id    — fetch a proposal
 * POST /proposals/check  — pre-flight limit check (no state change)
 */
import { createLogger, json, route, readBodyWithLimit } from "@delegolabs/utils";
import type { Pool } from "pg";
import { z } from "zod";
import { ProposalService } from "./service.js";
import {
  DelegationLimitExceededError,
  ConcurrentProposalConflictError,
} from "./types.js";

const log = createLogger(
  "orchestrator:proposals:routes",
  process.env.LOG_LEVEL ?? "info"
);

const ProposalItemSchema = z.object({
  productId: z.string().min(1),
  title: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPriceStroops: z.string().regex(/^\d+$/),
});

const CreateProposalSchema = z.object({
  userId: z.string().uuid(),
  delegationId: z.string().uuid(),
  merchantAddress: z.string().min(1),
  items: z.array(ProposalItemSchema).min(1),
  totalAmountStroops: z.string().regex(/^\d+$/),
  assetCode: z.string().min(1).max(12),
  rationale: z.string().min(1),
});

const CheckLimitSchema = z.object({
  userId: z.string().uuid(),
  delegationId: z.string().uuid(),
  amountStroops: z.string().regex(/^\d+$/),
});

export function createProposalRoutes(db: Pool) {
  const service = new ProposalService(db);

  return [
    route("POST", "/proposals", async (req, res) => {
      let body: unknown;
      try {
        const raw = await readBodyWithLimit(req);
        body = JSON.parse(raw);
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }

      const parsed = CreateProposalSchema.safeParse(body);
      if (!parsed.success) {
        json(res, 400, { error: "Validation failed", details: parsed.error.flatten() });
        return;
      }

      try {
        const proposal = await service.createProposal(parsed.data);
        json(res, 201, proposal);
      } catch (err) {
        if (err instanceof DelegationLimitExceededError) {
          json(res, 422, { error: err.message, code: "DELEGATION_LIMIT_EXCEEDED" });
          return;
        }
        if (err instanceof ConcurrentProposalConflictError) {
          json(res, 409, { error: err.message, code: "CONCURRENT_CONFLICT" });
          return;
        }
        log.error("Unexpected error creating proposal", {
          error: err instanceof Error ? err.message : String(err),
        });
        json(res, 500, { error: "Internal server error" });
      }
    }),

    route("POST", "/proposals/check", async (req, res) => {
      let body: unknown;
      try {
        const raw = await readBodyWithLimit(req);
        body = JSON.parse(raw);
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }

      const parsed = CheckLimitSchema.safeParse(body);
      if (!parsed.success) {
        json(res, 400, { error: "Validation failed", details: parsed.error.flatten() });
        return;
      }

      const result = await service.checkLimit(
        parsed.data.userId,
        parsed.data.delegationId,
        parsed.data.amountStroops
      );
      json(res, 200, result);
    }),
  ];
}

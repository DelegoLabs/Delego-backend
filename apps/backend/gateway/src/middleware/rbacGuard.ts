/**
 * Role-based authorization guard for merchant staff accounts (Issue #618).
 *
 * Merchant organizations have team members beyond the merchant owner — e.g.
 * catalog editors, financial auditors, and support reps — each of which must
 * be restricted to the narrowest set of API operations ("permission scopes")
 * their job requires. This module maps `MerchantRole` values to the
 * `PermissionScope`s they grant, resolves a caller's effective staff role(s)
 * for a given merchant, and exposes guards that enforce the required scope
 * before a route handler runs.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteHandler } from "@delegolabs/utils";
import { extractAuth } from "../../middleware/auth.js";
import { forbidden, unauthorized } from "../errors.js";
import { Merchant } from "../models/index.js";

/** Roles a merchant can assign to a staff account. */
export type MerchantRole =
  | "owner"
  | "admin"
  | "catalog_editor"
  | "financial_auditor"
  | "support_agent";

/** Fine-grained operations a merchant staff account may be permitted to perform. */
export type PermissionScope =
  | "catalog:write"
  | "catalog:read"
  | "orders:refund"
  | "payouts:withdraw"
  | "settings:manage";

/** A resolved merchant staff membership: which roles `userId` holds at `merchantId`. */
export interface MerchantStaffMember {
  userId: string;
  merchantId: string;
  roles: MerchantRole[];
}

/** Every permission scope, in canonical evaluation/display order. */
export const ALL_PERMISSION_SCOPES: readonly PermissionScope[] = [
  "catalog:write",
  "catalog:read",
  "orders:refund",
  "payouts:withdraw",
  "settings:manage",
];

/**
 * Role -> permission scope map, enforcing least privilege per role:
 *
 * - `owner`            — full access across all operations (acceptance criteria).
 * - `admin`            — day-to-day operational access, excluding fund withdrawal.
 * - `catalog_editor`   — product catalog management only; no financial endpoints
 *                         (acceptance criteria: cannot refund or withdraw payouts).
 * - `financial_auditor`— read-only access, for compliance review.
 * - `support_agent`    — read catalog + issue customer refunds; no payouts/settings.
 */
export const ROLE_PERMISSION_SCOPES: Readonly<Record<MerchantRole, readonly PermissionScope[]>> = {
  owner: ALL_PERMISSION_SCOPES,
  admin: ["catalog:write", "catalog:read", "orders:refund", "settings:manage"],
  catalog_editor: ["catalog:write", "catalog:read"],
  financial_auditor: ["catalog:read"],
  support_agent: ["catalog:read", "orders:refund"],
};

/** Union of the permission scopes granted by a set of roles, in canonical order. */
export function resolvePermissionScopes(
  roles: readonly MerchantRole[] | undefined | null,
): PermissionScope[] {
  if (!roles || roles.length === 0) return [];

  const granted = new Set<PermissionScope>();
  for (const role of roles) {
    for (const scope of ROLE_PERMISSION_SCOPES[role] ?? []) {
      granted.add(scope);
    }
  }

  return ALL_PERMISSION_SCOPES.filter((scope) => granted.has(scope));
}

/** Whether a staff member's roles grant a specific permission scope. */
export function hasPermissionScope(
  member: Pick<MerchantStaffMember, "roles"> | undefined | null,
  scope: PermissionScope,
): boolean {
  if (!member) return false;
  return resolvePermissionScopes(member.roles).includes(scope);
}

/**
 * In-memory merchant staff directory, keyed by `${merchantId}:${userId}`.
 *
 * Populated via `setMerchantStaffRoles` (e.g. from a staff-invite endpoint or
 * admin tooling — mirrors the existing `setMerchantDeliveryZones` pattern in
 * `merchant/routes.ts`). A merchant's `ownerUserId` is never required to be
 * present here: `getMerchantStaffMember` implicitly grants the "owner" role
 * to that user even if the directory holds no explicit entry for them.
 */
const staffRolesByKey = new Map<string, MerchantRole[]>();

function staffKey(merchantId: string, userId: string): string {
  return `${merchantId}:${userId}`;
}

/** Assign (replacing any existing) roles for a staff member at a merchant. */
export function setMerchantStaffRoles(
  merchantId: string,
  userId: string,
  roles: MerchantRole[],
): void {
  staffRolesByKey.set(staffKey(merchantId, userId), [...roles]);
}

/** Remove a staff member's access to a merchant. */
export function removeMerchantStaffMember(merchantId: string, userId: string): void {
  staffRolesByKey.delete(staffKey(merchantId, userId));
}

/** Read the explicitly-assigned roles for a staff member, if any. */
export function getMerchantStaffRoles(
  merchantId: string,
  userId: string,
): MerchantRole[] | undefined {
  return staffRolesByKey.get(staffKey(merchantId, userId));
}

/**
 * Resolve the full staff membership for `userId` at `merchantId`.
 *
 * Explicit staff-role assignments take precedence. Absent one, falls back to
 * the merchant's `ownerUserId`, which implicitly carries the "owner" role so
 * the merchant's creator is never locked out of their own store. Returns
 * `null` when the user has no standing at this merchant at all.
 */
export async function getMerchantStaffMember(
  merchantId: string,
  userId: string,
): Promise<MerchantStaffMember | null> {
  const explicitRoles = staffRolesByKey.get(staffKey(merchantId, userId));
  if (explicitRoles && explicitRoles.length > 0) {
    return { userId, merchantId, roles: explicitRoles };
  }

  const merchant = await Merchant.findByPk(merchantId);
  if (merchant && merchant.ownerUserId === userId) {
    return { userId, merchantId, roles: ["owner"] };
  }

  return null;
}

/**
 * Resolve the merchant id a request is scoped to: route params first
 * (`merchantId`, then `id`), falling back to the `x-merchant-id` header so
 * internal/service callers can scope requests without a path param.
 */
export function resolveMerchantId(
  req: IncomingMessage,
  params: Record<string, string> = {},
): string | null {
  const fromParams = params.merchantId ?? params.id;
  if (fromParams) return fromParams;

  const header = req.headers["x-merchant-id"];
  if (typeof header === "string" && header.length > 0) return header;
  if (Array.isArray(header) && header.length > 0) return header[0];

  return null;
}

/**
 * Enforce that the authenticated caller holds `scope` for `merchantId`.
 *
 * Writes the 401/403 error envelope and returns `false` when the caller
 * should stop handling the request; `true` when authorized to proceed.
 */
export async function requireMerchantPermission(
  req: IncomingMessage,
  res: ServerResponse,
  merchantId: string | null,
  scope: PermissionScope,
): Promise<boolean> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return false;
  }

  if (!merchantId) {
    forbidden(res, "Merchant id is required", req);
    return false;
  }

  const member = await getMerchantStaffMember(merchantId, auth.userId);
  if (!member || !hasPermissionScope(member, scope)) {
    forbidden(res, `Missing required permission: ${scope}`, req);
    return false;
  }

  return true;
}

/**
 * Wrap a `RouteHandler` so it only runs once `scope` is verified for the
 * merchant resolved from the route params / `x-merchant-id` header.
 *
 * ```ts
 * route(
 *   "POST",
 *   "/api/v1/merchants/:merchantId/payouts",
 *   guardMerchantPermission("payouts:withdraw", handlePayoutWithdrawal),
 * );
 * ```
 */
export function guardMerchantPermission(scope: PermissionScope, handler: RouteHandler): RouteHandler {
  return async (req, res, params) => {
    const merchantId = resolveMerchantId(req, params);
    const authorized = await requireMerchantPermission(req, res, merchantId, scope);
    if (!authorized) return;
    await handler(req, res, params);
  };
}

/**
 * Field-level access control for decrypted PII (#68).
 *
 * Decrypting a PII column is only permitted for callers whose role appears
 * in the column's `decryptRoles` registry entry (see pii-registry.ts). If no
 * registry entry exists for a table.column the default policy *denies*
 * decryption — fail closed — since an unregistered column is either
 * non-PII (and should not be in the encryptor's path at all) or missing
 * PII classification (an oversight worth surfacing).
 */

import { EncryptionError } from "./cipher.js";
import type { FieldAccessRole, PiiAccessDecision, PiiColumn } from "@delegolabs/types";
import { lookupPiiColumn } from "@delegolabs/types";

export interface FieldAccessControllerOptions {
  /** Override registry lookups. Defaults to @delegolabs/types' PII_REGISTRY. */
  lookup?: (table: string, column: string) => PiiColumn | undefined;
}

export class FieldAccessController {
  private readonly lookup: (table: string, column: string) => PiiColumn | undefined;

  constructor(options: FieldAccessControllerOptions = {}) {
    this.lookup = options.lookup ?? ((table: string, column: string) => lookupPiiColumn(table, column));
  }

  /**
   * Evaluate whether `role` may decrypt `table.column`. Never throws: the
   * caller decides how to surface a denial (usually a thrown
   * EncryptionError + an audit record).
   */
  decide(table: string, column: string, role: FieldAccessRole): PiiAccessDecision {
    const entry = this.lookup(table, column);

    if (!entry) {
      return {
        allowed: false,
        table,
        column,
        role,
        reason: "not a registered PII column — fail closed (see pii-registry.ts)",
      };
    }

    if (entry.decryptRoles.length === 0) {
      return {
        allowed: false,
        table,
        column,
        role,
        reason: "column grants decryption to no roles (system-only)",
      };
    }

    if (entry.decryptRoles.includes(role)) {
      return { allowed: true, table, column, role, reason: "role permitted by registry" };
    }

    return {
      allowed: false,
      table,
      column,
      role,
      reason: `role '${role}' is not in allowed decrypt roles [${entry.decryptRoles.join(", ")}]`,
    };
  }

  /** Registry entry for a column (used by the encryptor for blind-index metadata). */
  lookupFor(table: string, column: string): PiiColumn | undefined {
    return this.lookup(table, column);
  }

  /** Convenience: throws EncryptionError when the role is not permitted. */
  assertCanDecrypt(table: string, column: string, role: FieldAccessRole): PiiColumn {
    const decision = this.decide(table, column, role);
    if (!decision.allowed) {
      throw new EncryptionError(
        `Access denied decrypting ${table}.${column} for role '${role}': ${decision.reason}`
      );
    }
    return this.lookup(table, column)!;
  }
}

/** Roles exposed for policy authoring; mirrors @delegolabs/types FieldAccessRole. */
export type { FieldAccessRole };
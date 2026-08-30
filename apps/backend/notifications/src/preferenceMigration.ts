// Preference migration tool (#115).
// Backfills the JSONB preference document from the legacy per-channel boolean
// columns (version 1) into the preference center model (version 2) and records
// every migration in preference_migrations.

import { createLogger } from "@delegolabs/utils";
import {
  getDefaultNotificationPreference,
  applyPreferenceUpdate,
  type NotificationPreference,
  type PreferenceMigration,
} from "./preferenceCenter.js";
import {
  createMigrationRecord,
  getStoredPreference,
  listLegacyPreferences,
  upsertStoredPreference,
  PREFERENCE_VERSION_CURRENT,
  type PreferenceDb,
} from "./preferenceCenterStore.js";

const log = createLogger(
  "notifications:preference-migration",
  process.env.LOG_LEVEL ?? "info"
);

export const PREFERENCE_VERSION_LEGACY = 1;

/**
 * Build a version-2 preference document from a legacy version-1 row. Legacy
 * rows only carry email/push toggles; everything else keeps built-in defaults.
 */
export function migrateLegacyPreferences(
  legacy: {
    userId: string;
    emailEnabled: boolean;
    pushEnabled: boolean;
  }
): { preferences: NotificationPreference; changes: Record<string, unknown> } {
  const base = getDefaultNotificationPreference(legacy.userId);
  const preferences = applyPreferenceUpdate(base, {
    channels: {
      email: { enabled: legacy.emailEnabled },
      push: { enabled: legacy.pushEnabled },
    },
  });
  return {
    preferences,
    changes: {
      emailEnabled: legacy.emailEnabled,
      pushEnabled: legacy.pushEnabled,
      migrated: true,
    },
  };
}

/**
 * Migrate one user from the legacy boolean columns to the JSONB document.
 * Returns "completed" when the row was migrated and "failed" when the user had
 * already been migrated or could not be.
 */
export async function migrateUserPreferences(
  db: PreferenceDb,
  userId: string,
  legacy: { emailEnabled: boolean; pushEnabled: boolean }
): Promise<{ status: "pending" | "completed" | "failed"; changes: Record<string, unknown> }> {
  const existing = await getStoredPreference(db, userId);
  if (existing?.preferences) {
    log.info("User preferences already migrated", { userId });
    return {
      status: "failed",
      changes: { error: "already_migrated" },
    };
  }

  const { preferences, changes } = migrateLegacyPreferences({
    userId,
    emailEnabled: legacy.emailEnabled,
    pushEnabled: legacy.pushEnabled,
  });

  try {
    await upsertStoredPreference(db, userId, preferences);
    await createMigrationRecord(db, {
      userId,
      fromVersion: PREFERENCE_VERSION_LEGACY,
      toVersion: PREFERENCE_VERSION_CURRENT,
      changes,
      status: "completed",
    });
    log.info("Migrated user notification preferences", { userId });
    return { status: "completed", changes };
  } catch (err) {
    log.error("Failed to migrate user notification preferences", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: "failed",
      changes: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

export interface RunMigrationOptions {
  limit?: number;
}

/**
 * Migrate all legacy preference rows to the preference center model.
 * Safe to re-run: rows without a `preferences` document are processed, rows
 * that already carry one are skipped and reported as failed.
 */
export async function runPreferenceMigration(
  db: PreferenceDb,
  options: RunMigrationOptions = {}
): Promise<PreferenceMigration> {
  const legacyRows = await listLegacyPreferences(db, options.limit ?? 100);
  const migrations: PreferenceMigration["migrations"] = [];

  for (const row of legacyRows) {
    const result = await migrateUserPreferences(db, row.userId, row);
    migrations.push({
      userId: row.userId,
      changes: result.changes,
      status: result.status,
    });
  }

  log.info("Preference migration run complete", {
    scanned: legacyRows.length,
    migrated: migrations.filter((m) => m.status === "completed").length,
  });

  return {
    fromVersion: PREFERENCE_VERSION_LEGACY,
    toVersion: PREFERENCE_VERSION_CURRENT,
    migrations,
  };
}

import { describe, it, expect, vi } from "vitest";
import {
  migrateLegacyPreferences,
  migrateUserPreferences,
  runPreferenceMigration,
  PREFERENCE_VERSION_LEGACY,
} from "./preferenceMigration.js";
import { PREFERENCE_VERSION_CURRENT, type PreferenceDb } from "./preferenceCenterStore.js";

function makeDb(rowsByCall: unknown[][]): PreferenceDb {
  const query = vi.fn();
  rowsByCall.forEach((rows, i) => query.mockResolvedValueOnce({ rows }));
  return { query };
}

const legacyRow = (userId: string, emailEnabled = true, pushEnabled = true) => ({
  user_id: userId,
  email_enabled: emailEnabled,
  push_enabled: pushEnabled,
  updated_at: new Date("2026-01-01T00:00:00Z"),
});

describe("migrateLegacyPreferences", () => {
  it("builds a version-2 document from legacy toggles", () => {
    const { preferences, changes } = migrateLegacyPreferences({
      userId: "user-1",
      emailEnabled: false,
      pushEnabled: true,
    });
    expect(preferences.userId).toBe("user-1");
    expect(preferences.channels.email.enabled).toBe(false);
    expect(preferences.channels.push.enabled).toBe(true);
    expect(preferences.channels.sms.enabled).toBe(true);
    expect(changes.migrated).toBe(true);
  });
});

describe("migrateUserPreferences", () => {
  it("migrates a legacy-only user and records the migration", async () => {
    const db = makeDb([
      [], // getStoredPreference -> no existing document
      [legacyRow("user-1", false, true)], // upsertStoredPreference RETURNING
      [], // createMigrationRecord
    ]);
    const result = await migrateUserPreferences(db, "user-1", {
      emailEnabled: false,
      pushEnabled: true,
    });
    expect(result.status).toBe("completed");
    expect(result.changes).toMatchObject({ emailEnabled: false, pushEnabled: true });

    const sqls = (db.query as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);
    expect(sqls.join("\n")).toMatch(/INSERT INTO preference_migrations/);
  });

  it("fails fast for an already-migrated user", async () => {
    const storedDoc = migrateLegacyPreferences({ userId: "user-1", emailEnabled: true, pushEnabled: true }).preferences;
    const db = makeDb([
      [{ user_id: "user-1", org_id: null, email_enabled: true, push_enabled: true, preferences: storedDoc, version: 2, updated_at: new Date() }],
    ]);
    const result = await migrateUserPreferences(db, "user-1", { emailEnabled: true, pushEnabled: true });
    expect(result.status).toBe("failed");
    expect(result.changes).toMatchObject({ error: "already_migrated" });
  });
});

describe("runPreferenceMigration", () => {
  it("migrates every legacy row and reports per-user status", async () => {
    const db = makeDb([
      // listLegacyPreferences
      [legacyRow("user-1"), legacyRow("user-2", false, false)],
      // user-1: getStoredPreference, upsertStoredPreference RETURNING, createMigrationRecord
      [], [legacyRow("user-1")], [],
      // user-2: getStoredPreference, upsertStoredPreference RETURNING, createMigrationRecord
      [], [legacyRow("user-2", false, false)], [],
    ]);
    const result = await runPreferenceMigration(db, { limit: 100 });
    expect(result.fromVersion).toBe(PREFERENCE_VERSION_LEGACY);
    expect(result.toVersion).toBe(PREFERENCE_VERSION_CURRENT);
    expect(result.migrations).toHaveLength(2);
    expect(result.migrations.every((m) => m.status === "completed")).toBe(true);
    expect(result.migrations.map((m) => m.userId)).toEqual(["user-1", "user-2"]);
  });

  it("returns an empty result when there is nothing to migrate", async () => {
    const db = makeDb([[]]);
    const result = await runPreferenceMigration(db);
    expect(result.migrations).toEqual([]);
  });
});

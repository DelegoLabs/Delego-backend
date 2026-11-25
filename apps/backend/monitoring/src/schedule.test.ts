import { describe, it, expect, afterEach, vi } from "vitest";
import type { OnCallSchedule } from "@delegolabs/types";
import {
  createSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  getCurrentOnCall,
  getOnCallUsers,
  addOverride,
  removeOverride,
  createHandoff,
  acknowledgeHandoff,
  getHandoffs,
  getTeamSchedules,
} from "./schedule.js";

function makeSchedule(overrides: Partial<OnCallSchedule> = {}): OnCallSchedule {
  return {
    id: `sched_${Math.random().toString(36).slice(2)}`,
    name: "Primary On-Call",
    team: "platform",
    timezone: "UTC",
    rotations: [
      {
        userId: "user-primary",
        role: "primary",
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-08T00:00:00.000Z",
      },
      {
        userId: "user-secondary",
        role: "secondary",
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-08T00:00:00.000Z",
      },
    ],
    overrides: [],
    ...overrides,
  };
}

describe("schedule", () => {
  const createdScheduleIds: string[] = [];

  afterEach(() => {
    for (const id of createdScheduleIds.splice(0)) {
      deleteSchedule(id);
    }
    vi.useRealTimers();
  });

  describe("schedule CRUD and team filtering", () => {
    it("creates, retrieves, lists, updates, filters by team, and deletes schedules", () => {
      const schedA = makeSchedule({ id: "sched-crud-a", team: "payments-team" });
      const schedB = makeSchedule({ id: "sched-crud-b", team: "infra-team" });
      createdScheduleIds.push(schedA.id, schedB.id);

      expect(createSchedule(schedA)).toEqual(schedA);
      createSchedule(schedB);

      expect(getSchedule(schedA.id)).toEqual(schedA);
      expect(listSchedules().some((s) => s.id === schedA.id)).toBe(true);
      expect(getTeamSchedules("payments-team").map((s) => s.id)).toContain(schedA.id);
      expect(getTeamSchedules("payments-team").map((s) => s.id)).not.toContain(schedB.id);

      const updated = updateSchedule(schedA.id, { name: "Updated Primary", id: "ignored" });
      expect(updated?.name).toBe("Updated Primary");
      expect(updated?.id).toBe(schedA.id);

      expect(updateSchedule("missing-sched", { name: "Nope" })).toBeNull();
      expect(deleteSchedule(schedA.id)).toBe(true);
      expect(getSchedule(schedA.id)).toBeNull();
      expect(deleteSchedule(schedA.id)).toBe(false);
    });
  });

  describe("on-call resolution and overrides", () => {
    it("returns active rotation user, prefers active override, and handles out-of-range dates", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-03T12:00:00.000Z"));

      const sched = makeSchedule({ id: "sched-oncall-1" });
      createdScheduleIds.push(sched.id);
      createSchedule(sched);

      expect(getCurrentOnCall("missing-sched")).toBeNull();
      expect(getCurrentOnCall(sched.id)).toEqual({
        userId: "user-primary",
        role: "primary",
      });

      expect(
        addOverride(sched.id, {
          userId: "user-override",
          start: "2026-01-03T00:00:00.000Z",
          end: "2026-01-04T00:00:00.000Z",
          reason: "PTO coverage",
        })
      ).toBe(true);
      expect(addOverride("missing-sched", { userId: "u", start: "", end: "", reason: "" })).toBe(
        false
      );

      expect(getCurrentOnCall(sched.id)).toEqual({
        userId: "user-override",
        role: "primary",
      });

      expect(removeOverride(sched.id, "user-override", "2026-01-03T00:00:00.000Z")).toBe(true);
      expect(removeOverride(sched.id, "user-override", "2026-01-03T00:00:00.000Z")).toBe(false);
      expect(removeOverride("missing-sched", "u", "")).toBe(false);

      // Outside all rotation windows
      vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
      expect(getCurrentOnCall(sched.id)).toBeNull();
    });

    it("lists all on-call users for a specific date", () => {
      const sched = makeSchedule({ id: "sched-users-1" });
      createdScheduleIds.push(sched.id);
      createSchedule(sched);

      expect(getOnCallUsers("missing-sched")).toEqual([]);

      const users = getOnCallUsers(sched.id, new Date("2026-01-02T00:00:00.000Z"));
      expect(users).toHaveLength(2);
      expect(users.map((u) => u.userId)).toEqual(["user-primary", "user-secondary"]);

      expect(getOnCallUsers(sched.id, new Date("2026-03-01T00:00:00.000Z"))).toEqual([]);
    });
  });

  describe("handoffs", () => {
    it("creates, lists, and acknowledges handoffs", () => {
      const scheduleId = "sched-handoff-1";
      expect(getHandoffs(scheduleId)).toEqual([]);

      const handoff = createHandoff(scheduleId, "user-a", "user-b", "All quiet");
      expect(handoff.acknowledged).toBe(false);
      expect(handoff.notes).toBe("All quiet");
      expect(getHandoffs(scheduleId)).toHaveLength(1);

      expect(acknowledgeHandoff("missing-id", scheduleId)).toBe(false);
      expect(acknowledgeHandoff(handoff.id, scheduleId)).toBe(true);
      expect(getHandoffs(scheduleId)[0].acknowledged).toBe(true);
    });
  });
});

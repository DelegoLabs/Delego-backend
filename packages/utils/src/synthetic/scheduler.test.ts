/**
 * Tests for Check Scheduler
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { CheckScheduler, parseCron } from "./scheduler.js";

describe("CheckScheduler", () => {
  let scheduler: CheckScheduler;

  beforeEach(() => {
    scheduler = new CheckScheduler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Schedule Management", () => {
    it("should add schedule", () => {
      const schedule = {
        id: "test-schedule",
        name: "Test Schedule",
        cron: "*/5 * * * *",
        checks: [],
        timezone: "UTC",
      };

      scheduler.addSchedule(schedule);

      const schedules = scheduler.listSchedules();
      expect(schedules.length).toBeGreaterThan(0);
    });

    it("should update schedule", () => {
      const schedule = {
        id: "test-schedule",
        name: "Test Schedule",
        cron: "*/5 * * * *",
        checks: [],
        timezone: "UTC",
      };

      scheduler.addSchedule(schedule);

      const updated = scheduler.updateSchedule("test-schedule", {
        name: "Updated Schedule",
        cron: "*/10 * * * *",
      });

      expect(updated).toBe(true);

      const schedules = scheduler.listSchedules();
      const updatedSchedule = schedules.find((s) => s.id === "test-schedule");
      expect(updatedSchedule?.name).toBe("Updated Schedule");
      expect(updatedSchedule?.cron).toBe("*/10 * * * *");
    });

    it("should remove schedule", () => {
      const schedule = {
        id: "remove-me",
        name: "Remove Me",
        cron: "*/5 * * * *",
        checks: [],
        timezone: "UTC",
      };

      scheduler.addSchedule(schedule);

      const removed = scheduler.removeSchedule("remove-me");
      expect(removed).toBe(true);

      const schedules = scheduler.listSchedules();
      expect(schedules.find((s) => s.id === "remove-me")).toBeUndefined();
    });

    it("should add check to schedule", () => {
      scheduler.addSchedule({
        id: "test-schedule",
        name: "Test Schedule",
        cron: "*/5 * * * *",
        checks: [],
        timezone: "UTC",
      });

      const added = scheduler.addCheckToSchedule("test-schedule", "check-1");

      expect(added).toBe(true);

      const schedules = scheduler.listSchedules();
      expect(schedules[0].checks).toContain("check-1");
    });

    it("should remove check from schedule", () => {
      scheduler.addSchedule({
        id: "test-schedule",
        name: "Test Schedule",
        cron: "*/5 * * * *",
        checks: ["check-1", "check-2"],
        timezone: "UTC",
      });

      const removed = scheduler.removeCheckFromSchedule("test-schedule", "check-1");

      expect(removed).toBe(true);

      const schedules = scheduler.listSchedules();
      expect(schedules[0].checks).not.toContain("check-1");
    });
  });

  describe("Cron Parsing", () => {
    it("should parse cron expression", () => {
      const parsed = parseCron("*/5 * * * *");
      
      expect(parsed).toBeDefined();
      expect(parsed?.minute).toBe("*/5");
      expect(parsed?.hour).toBe("*");
      expect(parsed?.day).toBe("*");
      expect(parsed?.month).toBe("*");
      expect(parsed?.weekday).toBe("*");
    });

    it("should return null for invalid cron", () => {
      const parsed = parseCron("invalid cron");
      expect(parsed).toBeNull();
    });
  });

  describe("Frequency Calculation", () => {
    it("should calculate frequency for minute interval", () => {
      const scheduler = new CheckScheduler();
      const frequency = (scheduler as any).getCronFrequency("*/5 * * * *");
      expect(frequency).toBe(300); // 5 minutes
    });

    it("should calculate frequency for hourly", () => {
      const scheduler = new CheckScheduler();
      const frequency = (scheduler as any).getCronFrequency("0 * * * *");
      expect(frequency).toBe(3600); // 1 hour
    });

    it("should calculate frequency for daily", () => {
      const scheduler = new CheckScheduler();
      const frequency = (scheduler as any).getCronFrequency("0 0 * * *");
      expect(frequency).toBe(86400); // 24 hours
    });
  });

  describe("Scheduling", () => {
    it("should start and stop schedule", async () => {
      const executeCheck = vi.fn();
      
      scheduler.addSchedule({
        id: "test-schedule",
        name: "Test Schedule",
        cron: "*/1 * * * *", // Every minute for testing
        checks: ["check-1"],
        timezone: "UTC",
      });

      await scheduler.startSchedule("test-schedule", executeCheck);

      const active = scheduler.getActiveTasks();
      expect(active.length).toBeGreaterThan(0);

      await scheduler.stopSchedule("test-schedule");

      const activeAfter = scheduler.getActiveTasks();
      expect(activeAfter.length).toBe(0);
    });

    it("should execute schedule", async () => {
      const executeCheck = vi.fn();

      scheduler.addSchedule({
        id: "test-schedule",
        name: "Test Schedule",
        cron: "*/5 * * * *",
        checks: ["check-1", "check-2"],
        timezone: "UTC",
      });

      await scheduler.executeSchedule("test-schedule", executeCheck);

      expect(executeCheck).toHaveBeenCalledTimes(2);
    });

    it("should get schedules for check", () => {
      scheduler.addSchedule({
        id: "schedule-1",
        name: "Schedule 1",
        cron: "*/5 * * * *",
        checks: ["check-1"],
        timezone: "UTC",
      });

      scheduler.addSchedule({
        id: "schedule-2",
        name: "Schedule 2",
        cron: "*/10 * * * *",
        checks: ["check-1", "check-2"],
        timezone: "UTC",
      });

      const schedules = scheduler.getSchedulesForCheck("check-1");
      expect(schedules.length).toBe(2);
      expect(schedules).toContain("schedule-1");
      expect(schedules).toContain("schedule-2");
    });
  });

  describe("Stop All", () => {
    it("should stop all active tasks", async () => {
      const executeCheck = vi.fn();

      scheduler.addSchedule({
        id: "schedule-1",
        name: "Schedule 1",
        cron: "*/1 * * * *",
        checks: [],
        timezone: "UTC",
      });

      scheduler.addSchedule({
        id: "schedule-2",
        name: "Schedule 2",
        cron: "*/1 * * * *",
        checks: [],
        timezone: "UTC",
      });

      await scheduler.startSchedule("schedule-1", executeCheck);
      await scheduler.startSchedule("schedule-2", executeCheck);

      scheduler.stopAll();

      const active = scheduler.getActiveTasks();
      expect(active.length).toBe(0);
    });
  });
});
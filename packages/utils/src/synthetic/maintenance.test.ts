/**
 * Tests for Maintenance Window Manager
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MaintenanceWindowManager } from "./maintenance.js";

describe("MaintenanceWindowManager", () => {
  let manager: MaintenanceWindowManager;

  beforeEach(() => {
    manager = new MaintenanceWindowManager();
  });

  describe("Window Management", () => {
    it("should add window", () => {
      const window = {
        id: "test-window",
        name: "Test Maintenance",
        startTime: new Date(Date.now() - 3600000).toISOString(), // Started 1 hour ago
        endTime: new Date(Date.now() + 3600000).toISOString(), // Ends in 1 hour
        checks: ["check-1"],
        reason: "Planned maintenance",
        enabled: true,
      };

      manager.addWindow(window);

      const windows = manager.listWindows();
      expect(windows.length).toBeGreaterThan(0);
    });

    it("should update window", () => {
      const window = {
        id: "test-window",
        name: "Test Maintenance",
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 3600000).toISOString(),
        checks: ["check-1"],
        reason: "Planned maintenance",
        enabled: true,
      };

      manager.addWindow(window);

      const updated = manager.updateWindow("test-window", {
        name: "Updated Maintenance",
      });

      expect(updated).toBe(true);

      const windows = manager.listWindows();
      expect(windows[0].name).toBe("Updated Maintenance");
    });

    it("should remove window", () => {
      const window = {
        id: "remove-me",
        name: "Remove Me",
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 3600000).toISOString(),
        checks: ["check-1"],
        reason: "Planned maintenance",
        enabled: true,
      };

      manager.addWindow(window);

      const removed = manager.removeWindow("remove-me");
      expect(removed).toBe(true);

      const windows = manager.listWindows();
      expect(windows.find((w) => w.id === "remove-me")).toBeUndefined();
    });
  });

  describe("Check Activation", () => {
    it("should return true when no maintenance windows", () => {
      const isActive = manager.isCheckActive("check-1");
      expect(isActive).toBe(true);
    });

    it("should return false during maintenance", () => {
      const now = new Date();
      const window = {
        id: "test-window",
        name: "Test Maintenance",
        startTime: new Date(now.getTime() - 3600000).toISOString(), // Started 1 hour ago
        endTime: new Date(now.getTime() + 3600000).toISOString(), // Ends in 1 hour
        checks: ["check-1"],
        reason: "Planned maintenance",
        enabled: true,
      };

      manager.addWindow(window);

      const isActive = manager.isCheckActive("check-1", now);
      expect(isActive).toBe(false);
    });

    it("should return true outside maintenance window", () => {
      const now = new Date();
      const window = {
        id: "test-window",
        name: "Test Maintenance",
        startTime: new Date(now.getTime() - 7200000).toISOString(), // Started 2 hours ago
        endTime: new Date(now.getTime() - 3600000).toISOString(), // Ended 1 hour ago
        checks: ["check-1"],
        reason: "Planned maintenance",
        enabled: true,
      };

      manager.addWindow(window);

      const isActive = manager.isCheckActive("check-1", now);
      expect(isActive).toBe(true);
    });
  });

  describe("Active Windows", () => {
    it("should get active windows", () => {
      const now = new Date();
      const window = {
        id: "test-window",
        name: "Test Maintenance",
        startTime: new Date(now.getTime() - 3600000).toISOString(),
        endTime: new Date(now.getTime() + 3600000).toISOString(),
        checks: ["check-1"],
        reason: "Planned maintenance",
        enabled: true,
      };

      manager.addWindow(window);

      const active = manager.getActiveWindows(now);
      expect(active.length).toBe(1);
    });
  });

  describe("Maintenance Mode", () => {
    it("should check maintenance mode", () => {
      const now = new Date();
      const window = {
        id: "test-window",
        name: "Test Maintenance",
        startTime: new Date(now.getTime() - 3600000).toISOString(),
        endTime: new Date(now.getTime() + 3600000).toISOString(),
        checks: ["check-1"],
        reason: "Planned maintenance",
        enabled: true,
      };

      manager.addWindow(window);

      const inMaintenance = manager.isMaintenanceMode("check-1", now);
      expect(inMaintenance).toBe(true);
    });
  });

  describe("Maintenance Windows for Check", () => {
    it("should get maintenance windows for check", () => {
      const now = new Date();
      const window = {
        id: "test-window",
        name: "Test Maintenance",
        startTime: new Date(now.getTime() - 3600000).toISOString(),
        endTime: new Date(now.getTime() + 3600000).toISOString(),
        checks: ["check-1"],
        reason: "Planned maintenance",
        enabled: true,
      };

      manager.addWindow(window);

      const windows = manager.getMaintenanceWindows("check-1", now);
      expect(windows.length).toBe(1);
    });
  });

  describe("Upcoming Windows", () => {
    it("should get upcoming windows", () => {
      const now = new Date();
      const window = {
        id: "upcoming-window",
        name: "Upcoming Maintenance",
        startTime: new Date(now.getTime() + 3600000).toISOString(), // In 1 hour
        endTime: new Date(now.getTime() + 7200000).toISOString(), // In 2 hours
        checks: ["check-1"],
        reason: "Planned maintenance",
        enabled: true,
      };

      manager.addWindow(window);

      const upcoming = manager.getUpcomingWindows(120); // 2 hours
      expect(upcoming.length).toBe(1);
    });
  });

  describe("Disabled Windows", () => {
    it("should respect disabled windows", () => {
      const now = new Date();
      const window = {
        id: "disabled-window",
        name: "Disabled Maintenance",
        startTime: new Date(now.getTime() - 3600000).toISOString(),
        endTime: new Date(now.getTime() + 3600000).toISOString(),
        checks: ["check-1"],
        reason: "Planned maintenance",
        enabled: false,
      };

      manager.addWindow(window);

      const isActive = manager.isCheckActive("check-1", now);
      expect(isActive).toBe(true); // Disabled window should be ignored
    });
  });

  describe("Clear Windows", () => {
    it("should clear all windows", () => {
      const window = {
        id: "window-1",
        name: "Window 1",
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 3600000).toISOString(),
        checks: ["check-1"],
        reason: "Planned maintenance",
        enabled: true,
      };

      manager.addWindow(window);
      manager.addWindow(window);

      manager.clearWindows();

      const windows = manager.listWindows();
      expect(windows.length).toBe(0);
    });
  });
});
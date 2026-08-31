/**
 * Maintenance Window Manager
 *
 * Manages maintenance windows to suppress alerts during planned maintenance.
 */

import { createLogger } from "../logger.js";
import type { MaintenanceWindow } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Maintenance Window Manager
// ─────────────────────────────────────────────────────────────────────────────

export class MaintenanceWindowManager {
  private windows = new Map<string, MaintenanceWindow>();

  // ─── Window Management ──────────────────────────────────────────────────

  addWindow(window: MaintenanceWindow): void {
    this.windows.set(window.id, window);
    log.info("Maintenance window added", {
      id: window.id,
      name: window.name,
      startTime: window.startTime,
      endTime: window.endTime,
    });
  }

  updateWindow(id: string, updates: Partial<MaintenanceWindow>): boolean {
    const existing = this.windows.get(id);
    if (!existing) return false;

    const updated = { ...existing, ...updates, id };
    this.windows.set(id, updated);
    return true;
  }

  removeWindow(id: string): boolean {
    return this.windows.delete(id);
  }

  listWindows(): MaintenanceWindow[] {
    return Array.from(this.windows.values());
  }

  // ─── Window Validation ──────────────────────────────────────────────────

  isCheckActive(checkId: string, now: Date = new Date()): boolean {
    const windows = Array.from(this.windows.values());
    const activeWindows = windows.filter((w) => this.isWindowActive(w, now));

    if (activeWindows.length === 0) {
      return true;
    }

    // Check if check is in any active maintenance window
    for (const window of activeWindows) {
      if (window.checks.includes(checkId)) {
        return false;
      }
    }

    return true;
  }

  private isWindowActive(window: MaintenanceWindow, now: Date = new Date()): boolean {
    if (!window.enabled) return false;

    const startTime = new Date(window.startTime);
    const endTime = new Date(window.endTime);
    
    return now >= startTime && now <= endTime;
  }

  // ─── Active Windows ─────────────────────────────────────────────────────

  getActiveWindows(now?: Date): MaintenanceWindow[] {
    return this.listWindows().filter((w) => this.isWindowActive(w, now));
  }

  // ─── Maintenance Mode ───────────────────────────────────────────────────

  isMaintenanceMode(checkId: string, now?: Date): boolean {
    return !this.isCheckActive(checkId, now);
  }

  // ─── Get Maintenance for Check ──────────────────────────────────────────

  getMaintenanceWindows(checkId: string, now?: Date): MaintenanceWindow[] {
    return this.listWindows().filter((w) => {
      if (!w.enabled) return false;
      if (!w.checks.includes(checkId)) return false;
      return this.isWindowActive(w, now);
    });
  }

  // ─── Utility Methods ────────────────────────────────────────────────────

  getUpcomingWindows(minutes: number = 60): MaintenanceWindow[] {
    const now = new Date();
    const future = new Date(now.getTime() + minutes * 60 * 1000);

    return this.listWindows().filter((w) => {
      if (!w.enabled) return false;
      const startTime = new Date(w.startTime);
      return startTime >= now && startTime <= future;
    });
  }

  clearWindows(): void {
    this.windows.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger("utils:synthetic-maintenance", process.env.LOG_LEVEL ?? "info");
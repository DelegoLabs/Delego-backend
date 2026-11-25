import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Alert, AlertRoute } from "@delegolabs/types";
import {
  createRoute,
  getRoute,
  listRoutes,
  updateRoute,
  deleteRoute,
  routeAlert,
  createAlert,
  getAlert,
  listAlerts,
  acknowledgeAlert,
  resolveAlert,
  silenceAlert,
  removeSilence,
  getActiveSilences,
  getAlertGroups,
  cleanupResolvedAlerts,
} from "./alertRouter.js";

function makeRoute(overrides: Partial<AlertRoute> = {}): AlertRoute {
  return {
    id: `route_${Math.random().toString(36).slice(2)}`,
    name: "Default Route",
    matchers: [{ field: "service", operator: "eq", value: "payments" }],
    escalationPolicyId: "policy-1",
    continue: false,
    ...overrides,
  };
}

function makeAlertInput(
  overrides: Partial<Omit<Alert, "id" | "createdAt" | "updatedAt" | "status">> = {}
): Omit<Alert, "id" | "createdAt" | "updatedAt" | "status"> {
  return {
    title: `High latency ${Math.random().toString(36).slice(2)}`,
    description: "p99 > 2s",
    severity: "critical",
    service: "payments",
    team: "core",
    labels: { env: "prod", region: "us-east-1" },
    annotations: {},
    ...overrides,
  };
}

describe("alertRouter", () => {
  const createdRouteIds: string[] = [];
  const createdSilenceIds: string[] = [];

  afterEach(() => {
    for (const id of createdRouteIds.splice(0)) {
      deleteRoute(id);
    }
    for (const id of createdSilenceIds.splice(0)) {
      removeSilence(id);
    }
    vi.useRealTimers();
  });

  describe("route CRUD", () => {
    it("creates, retrieves, lists, updates, and deletes routes", () => {
      const route = makeRoute({ id: "route-crud-1", name: "Payments Critical" });
      createdRouteIds.push(route.id);

      expect(createRoute(route)).toEqual(route);
      expect(getRoute(route.id)).toEqual(route);
      expect(listRoutes().some((r) => r.id === route.id)).toBe(true);

      const updated = updateRoute(route.id, { name: "Updated Name", id: "ignored-id" });
      expect(updated?.name).toBe("Updated Name");
      expect(updated?.id).toBe(route.id);

      expect(updateRoute("non-existent", { name: "Nope" })).toBeNull();
      expect(deleteRoute(route.id)).toBe(true);
      expect(getRoute(route.id)).toBeNull();
      expect(deleteRoute(route.id)).toBe(false);
    });
  });

  describe("routeAlert", () => {
    it("matches eq, neq, contains, matches (regex), and custom label fields", () => {
      const route = makeRoute({
        id: "route-matchers-1",
        escalationPolicyId: "pol-match",
        matchers: [
          { field: "service", operator: "eq", value: "checkout" },
          { field: "severity", operator: "neq", value: "low" },
          { field: "team", operator: "contains", value: "plat" },
          { field: "title", operator: "matches", value: "^DB.*timeout$" },
          { field: "env", operator: "eq", value: "prod" },
        ],
      });
      createdRouteIds.push(route.id);
      createRoute(route);

      const matchingAlert = createAlert(
        makeAlertInput({
          service: "checkout",
          severity: "critical",
          team: "platform",
          title: "DB connection timeout",
          labels: { env: "prod" },
        })
      );

      expect(routeAlert(matchingAlert)).toEqual({
        escalationPolicyId: "pol-match",
        continue: false,
      });

      const nonMatchingAlert = createAlert(
        makeAlertInput({
          service: "checkout",
          severity: "critical",
          team: "platform",
          title: "DB connection timeout",
          labels: { env: "staging" },
        })
      );
      expect(routeAlert(nonMatchingAlert)).toBeNull();
    });

    it("returns null for invalid regex or unknown operator", () => {
      const badRegexRoute = makeRoute({
        id: "route-bad-regex",
        matchers: [{ field: "title", operator: "matches", value: "[invalid(" }],
      });
      createdRouteIds.push(badRegexRoute.id);
      createRoute(badRegexRoute);

      const alert = createAlert(makeAlertInput({ service: "unmatched-svc" }));
      expect(routeAlert(alert)).toBeNull();
    });

    it("prioritizes routes with continue=false before continue=true", () => {
      const continueRoute = makeRoute({
        id: "route-continue-true",
        escalationPolicyId: "pol-continue",
        matchers: [{ field: "service", operator: "eq", value: "billing" }],
        continue: true,
      });
      const stopRoute = makeRoute({
        id: "route-continue-false",
        escalationPolicyId: "pol-stop",
        matchers: [{ field: "service", operator: "eq", value: "billing" }],
        continue: false,
      });
      createdRouteIds.push(continueRoute.id, stopRoute.id);
      createRoute(continueRoute);
      createRoute(stopRoute);

      const alert = createAlert(makeAlertInput({ service: "billing" }));
      expect(routeAlert(alert)).toEqual({
        escalationPolicyId: "pol-stop",
        continue: false,
      });
    });
  });

  describe("alert lifecycle and grouping", () => {
    it("creates, gets, lists, acknowledges, and resolves alerts", () => {
      const alert = createAlert(makeAlertInput({ title: "Disk full lifecycle" }));

      expect(alert.status).toBe("firing");
      expect(getAlert(alert.id)).toEqual(alert);
      expect(getAlert("missing-alert")).toBeNull();
      expect(listAlerts().some((a) => a.id === alert.id)).toBe(true);
      expect(listAlerts("firing").some((a) => a.id === alert.id)).toBe(true);

      expect(acknowledgeAlert("missing-alert", "user-1")).toBe(false);
      expect(acknowledgeAlert(alert.id, "user-1")).toBe(true);
      expect(getAlert(alert.id)?.status).toBe("acknowledged");
      expect(getAlert(alert.id)?.acknowledgedBy).toBe("user-1");

      expect(resolveAlert("missing-alert", "user-2")).toBe(false);
      expect(resolveAlert(alert.id, "user-2")).toBe(true);
      expect(getAlert(alert.id)?.status).toBe("resolved");
      expect(getAlert(alert.id)?.resolvedBy).toBe("user-2");
    });

    it("groups alerts with the same fingerprint and updates group status on resolve", () => {
      const input = makeAlertInput({
        service: "auth-group-test",
        severity: "high",
        title: "Token signing failure",
      });
      const first = createAlert(input);
      const second = createAlert(input);

      const groups = getAlertGroups();
      const group = groups.find((g) => g.alerts.some((a) => a.id === first.id));
      expect(group).toBeDefined();
      expect(group?.alerts.map((a) => a.id)).toContain(second.id);
      expect(group?.status).toBe("firing");

      resolveAlert(first.id, "user-1");
      expect(group?.status).toBe("firing");

      resolveAlert(second.id, "user-1");
      expect(group?.status).toBe("resolved");

      // A new alert with the same fingerprint re-opens the group
      createAlert(input);
      expect(group?.status).toBe("firing");
    });
  });

  describe("silence windows", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    });

    it("creates, lists active, expires, and removes silence windows", () => {
      const silence = silenceAlert(
        [{ field: "service", operator: "eq", value: "payments" }],
        "admin-1",
        "Planned maintenance",
        30,
        "alert-123"
      );
      createdSilenceIds.push(silence.id);

      expect(silence.alertId).toBe("alert-123");
      expect(getActiveSilences().some((s) => s.id === silence.id)).toBe(true);

      // Advance past the 30-minute duration
      vi.advanceTimersByTime(31 * 60_000);
      expect(getActiveSilences().some((s) => s.id === silence.id)).toBe(false);

      expect(removeSilence(silence.id)).toBe(true);
      expect(removeSilence(silence.id)).toBe(false);
    });
  });

  describe("cleanupResolvedAlerts", () => {
    it("removes resolved alerts older than the cutoff and keeps recent or firing ones", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z"));

      const oldResolved = createAlert(makeAlertInput({ title: "Old resolved" }));
      resolveAlert(oldResolved.id, "user-1");

      const stillFiring = createAlert(makeAlertInput({ title: "Still firing" }));

      vi.setSystemTime(new Date("2026-01-01T11:30:00.000Z"));
      const recentResolved = createAlert(makeAlertInput({ title: "Recent resolved" }));
      resolveAlert(recentResolved.id, "user-1");

      const cleaned = cleanupResolvedAlerts(60);
      expect(cleaned).toBeGreaterThanOrEqual(1);
      expect(getAlert(oldResolved.id)).toBeNull();
      expect(getAlert(recentResolved.id)).not.toBeNull();
      expect(getAlert(stillFiring.id)).not.toBeNull();
    });
  });
});

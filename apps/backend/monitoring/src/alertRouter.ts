/**
 * Alert routing with deduplication and silence windows
 * Issue #157
 */

import { createHash } from "node:crypto";
import { createLogger } from "@delegolabs/utils";
import type { Alert, AlertRoute, AlertGroup, SilenceWindow } from "@delegolabs/types";

const log = createLogger("monitoring:alert", process.env.LOG_LEVEL ?? "info");

const routes = new Map<string, AlertRoute>();
const alerts = new Map<string, Alert>();
const alertGroups = new Map<string, AlertGroup>();
const silenceWindows = new Map<string, SilenceWindow>();
const alertFingerprints = new Map<string, string>();

function computeFingerprint(alert: Alert): string {
  const data = `${alert.service}:${alert.severity}:${alert.title}`;
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

function matchesMatcher(
  alert: Alert,
  matchers: Array<{ field: string; operator: string; value: string }>
): boolean {
  return matchers.every((matcher) => {
    let fieldValue: string;

    switch (matcher.field) {
      case "service":
        fieldValue = alert.service;
        break;
      case "severity":
        fieldValue = alert.severity;
        break;
      case "team":
        fieldValue = alert.team;
        break;
      case "title":
        fieldValue = alert.title;
        break;
      default:
        fieldValue = alert.labels[matcher.field] ?? "";
    }

    switch (matcher.operator) {
      case "eq":
        return fieldValue === matcher.value;
      case "neq":
        return fieldValue !== matcher.value;
      case "contains":
        return fieldValue.includes(matcher.value);
      case "matches":
        try {
          return new RegExp(matcher.value).test(fieldValue);
        } catch {
          return false;
        }
      default:
        return false;
    }
  });
}

export function createRoute(route: AlertRoute): AlertRoute {
  routes.set(route.id, route);
  log.info("Alert route created", { id: route.id, name: route.name });
  return route;
}

export function getRoute(id: string): AlertRoute | null {
  return routes.get(id) ?? null;
}

export function listRoutes(): AlertRoute[] {
  return Array.from(routes.values());
}

export function updateRoute(id: string, updates: Partial<AlertRoute>): AlertRoute | null {
  const existing = routes.get(id);
  if (!existing) return null;

  const updated = { ...existing, ...updates, id };
  routes.set(id, updated);
  return updated;
}

export function deleteRoute(id: string): boolean {
  return routes.delete(id);
}

export function routeAlert(alert: Alert): {
  escalationPolicyId: string;
  continue: boolean;
} | null {
  const sortedRoutes = Array.from(routes.values()).sort((a, b) => {
    const aOrder = a.continue ? 1 : 0;
    const bOrder = b.continue ? 1 : 0;
    return aOrder - bOrder;
  });

  for (const route of sortedRoutes) {
    if (matchesMatcher(alert, route.matchers)) {
      log.info("Alert routed", {
        alertId: alert.id,
        routeId: route.id,
        routeName: route.name,
        escalationPolicyId: route.escalationPolicyId,
      });

      return {
        escalationPolicyId: route.escalationPolicyId,
        continue: route.continue,
      };
    }
  }

  return null;
}

export function createAlert(alertData: Omit<Alert, "id" | "createdAt" | "updatedAt" | "status">): Alert {
  const fingerprint = computeFingerprint(alertData as Alert);
  const existingGroup = Array.from(alertGroups.values()).find(
    (g) => g.fingerprint === fingerprint
  );

  const alert: Alert = {
    ...alertData,
    id: `alert_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    status: "firing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  alerts.set(alert.id, alert);
  alertFingerprints.set(alert.id, fingerprint);

  if (existingGroup) {
    existingGroup.alerts.push(alert);
    existingGroup.status = "firing";
  } else {
    alertGroups.set(fingerprint, {
      id: `group_${fingerprint}`,
      alerts: [alert],
      fingerprint,
      status: "firing",
      createdAt: new Date().toISOString(),
    });
  }

  log.info("Alert created", { id: alert.id, title: alert.title, severity: alert.severity });
  return alert;
}

export function getAlert(id: string): Alert | null {
  return alerts.get(id) ?? null;
}

export function listAlerts(status?: string): Alert[] {
  const allAlerts = Array.from(alerts.values());
  if (status) {
    return allAlerts.filter((a) => a.status === status);
  }
  return allAlerts;
}

export function acknowledgeAlert(id: string, userId: string): boolean {
  const alert = alerts.get(id);
  if (!alert) return false;

  alert.status = "acknowledged";
  alert.acknowledgedAt = new Date().toISOString();
  alert.acknowledgedBy = userId;
  alert.updatedAt = new Date().toISOString();

  log.info("Alert acknowledged", { id, userId });
  return true;
}

export function resolveAlert(id: string, userId: string): boolean {
  const alert = alerts.get(id);
  if (!alert) return false;

  alert.status = "resolved";
  alert.resolvedAt = new Date().toISOString();
  alert.resolvedBy = userId;
  alert.updatedAt = new Date().toISOString();

  const group = alertGroups.get(alertFingerprints.get(id) ?? "");
  if (group) {
    const allResolved = group.alerts.every((a) => a.status === "resolved");
    if (allResolved) {
      group.status = "resolved";
    }
  }

  log.info("Alert resolved", { id, userId });
  return true;
}

export function silenceAlert(
  matchers: SilenceWindow["matchers"],
  createdBy: string,
  reason: string,
  durationMinutes: number,
  alertId?: string
): SilenceWindow {
  const now = new Date();
  const window: SilenceWindow = {
    id: `silence_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    alertId,
    matchers,
    createdBy,
    reason,
    startsAt: now.toISOString(),
    endsAt: new Date(now.getTime() + durationMinutes * 60000).toISOString(),
  };

  silenceWindows.set(window.id, window);
  log.info("Silence window created", { id: window.id, durationMinutes });
  return window;
}

export function removeSilence(id: string): boolean {
  const deleted = silenceWindows.delete(id);
  if (deleted) log.info("Silence window removed", { id });
  return deleted;
}

export function getActiveSilences(): SilenceWindow[] {
  const now = new Date();
  return Array.from(silenceWindows.values()).filter(
    (w) => now >= new Date(w.startsAt) && now <= new Date(w.endsAt)
  );
}

export function getAlertGroups(): AlertGroup[] {
  return Array.from(alertGroups.values());
}

export function cleanupResolvedAlerts(olderThanMinutes: number = 60): number {
  const cutoff = Date.now() - olderThanMinutes * 60000;
  let cleaned = 0;

  for (const [id, alert] of alerts) {
    if (alert.status === "resolved" && alert.resolvedAt) {
      if (Date.parse(alert.resolvedAt) < cutoff) {
        alerts.delete(id);
        cleaned++;
      }
    }
  }

  return cleaned;
}

/**
 * Alert Routing with On-Call Schedules and Escalation
 * Issue #157
 */

export interface OnCallSchedule {
  id: string;
  name: string;
  team: string;
  timezone: string;
  rotations: Array<{
    userId: string;
    start: string;
    end: string;
    role: "primary" | "secondary" | "shadow";
  }>;
  overrides: Array<{
    userId: string;
    start: string;
    end: string;
    reason: string;
  }>;
}

export interface EscalationPolicy {
  id: string;
  name: string;
  steps: Array<{
    delayMinutes: number;
    targets: Array<{
      type: "schedule" | "user" | "team";
      id: string;
    }>;
    channels: ("pagerduty" | "slack" | "email" | "sms")[];
    repeat: boolean;
    repeatIntervalMinutes?: number;
  }>;
}

export interface AlertRoute {
  id: string;
  name: string;
  matchers: Array<{
    field: string;
    operator: "eq" | "neq" | "matches" | "contains";
    value: string;
  }>;
  escalationPolicyId: string;
  continue: boolean;
}

export interface NotificationChannel {
  id: string;
  type: "pagerduty" | "slack" | "email" | "sms";
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface Alert {
  id: string;
  title: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  service: string;
  team: string;
  status: "firing" | "acknowledged" | "resolved" | "silenced";
  routedTo?: string;
  escalatedAt?: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  silencedUntil?: string;
  labels: Record<string, string>;
  annotations: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SilenceWindow {
  id: string;
  alertId?: string;
  matchers: Array<{
    field: string;
    operator: "eq" | "neq" | "matches" | "contains";
    value: string;
  }>;
  createdBy: string;
  reason: string;
  startsAt: string;
  endsAt: string;
}

export interface AlertGroup {
  id: string;
  alerts: Alert[];
  fingerprint: string;
  status: "firing" | "acknowledged" | "resolved";
  createdAt: string;
}

export interface HandoffRecord {
  id: string;
  scheduleId: string;
  fromUserId: string;
  toUserId: string;
  handoffAt: string;
  acknowledged: boolean;
  notes?: string;
}

export interface AlertResponse {
  id: string;
  alertId: string;
  userId: string;
  action: "acknowledge" | "resolve" | "silence" | "escalate";
  message?: string;
  createdAt: string;
}

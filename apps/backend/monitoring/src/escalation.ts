/**
 * Escalation policy management
 * Issue #157
 */

import { createLogger } from "@delegolabs/utils";
import type { EscalationPolicy } from "@delegolabs/types";

const log = createLogger("monitoring:escalation", process.env.LOG_LEVEL ?? "info");

const policies = new Map<string, EscalationPolicy>();
const activeEscalations = new Map<string, {
  alertId: string;
  policyId: string;
  currentStep: number;
  startedAt: string;
  lastNotifiedAt: string;
  notifications: Array<{
    step: number;
    channel: string;
    targetId: string;
    sentAt: string;
    status: "sent" | "failed";
  }>;
}>();

export function createPolicy(policy: EscalationPolicy): EscalationPolicy {
  policies.set(policy.id, policy);
  log.info("Escalation policy created", { id: policy.id, name: policy.name });
  return policy;
}

export function getPolicy(id: string): EscalationPolicy | null {
  return policies.get(id) ?? null;
}

export function listPolicies(): EscalationPolicy[] {
  return Array.from(policies.values());
}

export function updatePolicy(id: string, updates: Partial<EscalationPolicy>): EscalationPolicy | null {
  const existing = policies.get(id);
  if (!existing) return null;

  const updated = { ...existing, ...updates, id };
  policies.set(id, updated);
  log.info("Escalation policy updated", { id });
  return updated;
}

export function deletePolicy(id: string): boolean {
  const deleted = policies.delete(id);
  if (deleted) log.info("Escalation policy deleted", { id });
  return deleted;
}

export function startEscalation(
  alertId: string,
  policyId: string
): {
  step: number;
  targets: Array<{ type: string; id: string }>;
  channels: string[];
} | null {
  const policy = policies.get(policyId);
  if (!policy || policy.steps.length === 0) return null;

  const escalation = {
    alertId,
    policyId,
    currentStep: 0,
    startedAt: new Date().toISOString(),
    lastNotifiedAt: new Date().toISOString(),
    notifications: [],
  };

  activeEscalations.set(alertId, escalation);

  const firstStep = policy.steps[0];
  log.info("Escalation started", { alertId, policyId, step: 0 });

  return {
    step: 0,
    targets: firstStep.targets,
    channels: firstStep.channels,
  };
}

export function advanceEscalation(alertId: string): {
  step: number;
  targets: Array<{ type: string; id: string }>;
  channels: string[];
  done: boolean;
} | null {
  const escalation = activeEscalations.get(alertId);
  if (!escalation) return null;

  const policy = policies.get(escalation.policyId);
  if (!policy) return null;

  const nextStep = escalation.currentStep + 1;
  if (nextStep >= policy.steps.length) {
    const currentStep = policy.steps[escalation.currentStep];
    if (currentStep.repeat && currentStep.repeatIntervalMinutes) {
      escalation.currentStep = 0;
      escalation.lastNotifiedAt = new Date().toISOString();
      return {
        step: 0,
        targets: currentStep.targets,
        channels: currentStep.channels,
        done: false,
      };
    }

    activeEscalations.delete(alertId);
    return { step: nextStep, targets: [], channels: [], done: true };
  }

  escalation.currentStep = nextStep;
  escalation.lastNotifiedAt = new Date().toISOString();

  const step = policy.steps[nextStep];
  log.info("Escalation advanced", { alertId, step: nextStep });

  return {
    step: nextStep,
    targets: step.targets,
    channels: step.channels,
    done: false,
  };
}

export function recordNotification(
  alertId: string,
  step: number,
  channel: string,
  targetId: string,
  status: "sent" | "failed"
): void {
  const escalation = activeEscalations.get(alertId);
  if (!escalation) return;

  escalation.notifications.push({
    step,
    channel,
    targetId,
    sentAt: new Date().toISOString(),
    status,
  });
}

export function getActiveEscalation(alertId: string) {
  return activeEscalations.get(alertId) ?? null;
}

export function resolveEscalation(alertId: string): boolean {
  const escalation = activeEscalations.get(alertId);
  if (!escalation) return false;

  activeEscalations.delete(alertId);
  log.info("Escalation resolved", { alertId });
  return true;
}

export function getEscalationHistory(alertId: string) {
  const escalation = activeEscalations.get(alertId);
  return escalation?.notifications ?? [];
}

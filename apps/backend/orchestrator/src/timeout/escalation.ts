/**
 * Issue #145 — Workflow timeout handling with automatic escalation.
 *
 * Enhances the base timeout detection (workflows/timeout.ts) with:
 *   1. Per-step timeout configuration
 *   2. Workflow-level timeout with escalation chain
 *   3. Automatic compensation on timeout
 *   4. Timeout extension API for manual override
 *   5. Timeout analytics dashboard data
 *   6. Different timeout policies per workflow type
 */

import { createLogger } from "@delegolabs/utils";

const log = createLogger("orchestrator:timeout-escalation", process.env.LOG_LEVEL ?? "info");

// ─── Types ──────────────────────────────────────────────────────────────────

export type EscalationAction = "alert" | "compensate" | "extend" | "notify_admin";

export interface EscalationStep {
  atMs: number;
  action: EscalationAction;
  config: Record<string, unknown>;
}

export interface WorkflowTimeoutConfig {
  workflowType: string;
  stepTimeouts: Record<string, number>;
  workflowTimeoutMs: number;
  escalationSteps: EscalationStep[];
}

export interface TimeoutEvent {
  workflowId: string;
  workflowType: string;
  currentStep: string;
  timeoutType: "step" | "workflow";
  configuredTimeoutMs: number;
  elapsedMs: number;
  action: "alerted" | "compensated" | "extended" | "notified";
  triggeredAt: string;
}

export interface TimeoutAnalytics {
  workflowType: string;
  totalTimeouts: number;
  byType: Record<string, number>;
  avgTimeToTimeout: number;
  compensationTriggered: number;
  extensionsGranted: number;
}

export interface StepTimeoutState {
  stepName: string;
  startedAt: number;
  timeoutMs: number;
  extended: boolean;
  extensionCount: number;
}

// ─── Default Configuration ──────────────────────────────────────────────────

export const DEFAULT_STEP_TIMEOUTS: Record<string, number> = {
  escrow_funding: 5 * 60 * 1000,
  merchant_fulfillment: 24 * 60 * 60 * 1000,
  delivery_verification: 7 * 24 * 60 * 60 * 1000,
  settlement: 30 * 60 * 1000,
};

export const DEFAULT_WORKFLOW_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;

export const DEFAULT_ESCALATION_STEPS: EscalationStep[] = [
  { atMs: 5 * 60 * 1000, action: "alert", config: { channel: "ops", severity: "warning" } },
  { atMs: 30 * 60 * 1000, action: "extend", config: { extensionMs: 30 * 60 * 1000 } },
  { atMs: 2 * 60 * 60 * 1000, action: "notify_admin", config: { channel: "admin", severity: "critical" } },
  { atMs: 24 * 60 * 60 * 1000, action: "compensate", config: { reason: "workflow_timeout" } },
];

// ─── Timeout Policy Store ───────────────────────────────────────────────────

const timeoutConfigs = new Map<string, WorkflowTimeoutConfig>();

export function registerTimeoutConfig(config: WorkflowTimeoutConfig): void {
  timeoutConfigs.set(config.workflowType, config);
  log.info("Timeout config registered", {
    workflowType: config.workflowType,
    workflowTimeoutMs: config.workflowTimeoutMs,
    stepCount: Object.keys(config.stepTimeouts).length,
    escalationSteps: config.escalationSteps.length,
  });
}

export function getTimeoutConfig(workflowType: string): WorkflowTimeoutConfig {
  return timeoutConfigs.get(workflowType) ?? {
    workflowType,
    stepTimeouts: DEFAULT_STEP_TIMEOUTS,
    workflowTimeoutMs: DEFAULT_WORKFLOW_TIMEOUT_MS,
    escalationSteps: DEFAULT_ESCALATION_STEPS,
  };
}

// ─── Step Timeout Tracker ───────────────────────────────────────────────────

class StepTimeoutTracker {
  private readonly steps = new Map<string, StepTimeoutState>();

  startStep(workflowId: string, stepName: string, timeoutMs: number): void {
    const key = `${workflowId}:${stepName}`;
    this.steps.set(key, {
      stepName,
      startedAt: Date.now(),
      timeoutMs,
      extended: false,
      extensionCount: 0,
    });
  }

  checkStepTimeout(workflowId: string, stepName: string): {
    timedOut: boolean;
    elapsedMs: number;
    configuredTimeoutMs: number;
  } {
    const key = `${workflowId}:${stepName}`;
    const state = this.steps.get(key);
    if (!state) return { timedOut: false, elapsedMs: 0, configuredTimeoutMs: 0 };

    const elapsedMs = Date.now() - state.startedAt;
    return {
      timedOut: elapsedMs >= state.timeoutMs,
      elapsedMs,
      configuredTimeoutMs: state.timeoutMs,
    };
  }

  extendStep(workflowId: string, stepName: string, additionalMs: number): boolean {
    const key = `${workflowId}:${stepName}`;
    const state = this.steps.get(key);
    if (!state) return false;

    state.timeoutMs += additionalMs;
    state.extended = true;
    state.extensionCount++;
    return true;
  }

  completeStep(workflowId: string, stepName: string): void {
    const key = `${workflowId}:${stepName}`;
    this.steps.delete(key);
  }

  getStepState(workflowId: string, stepName: string): StepTimeoutState | undefined {
    return this.steps.get(`${workflowId}:${stepName}`);
  }

  getActiveSteps(workflowId: string): StepTimeoutState[] {
    const prefix = `${workflowId}:`;
    const result: StepTimeoutState[] = [];
    for (const [key, state] of this.steps) {
      if (key.startsWith(prefix)) result.push(state);
    }
    return result;
  }
}

// ─── Escalation Engine ──────────────────────────────────────────────────────

const timeoutEvents: TimeoutEvent[] = [];

function triggerEscalation(
  workflowId: string,
  workflowType: string,
  currentStep: string,
  timeoutType: "step" | "workflow",
  configuredTimeoutMs: number,
  elapsedMs: number,
  escalation: EscalationStep
): TimeoutEvent {
  const event: TimeoutEvent = {
    workflowId,
    workflowType,
    currentStep,
    timeoutType,
    configuredTimeoutMs,
    elapsedMs,
    action: mapEscalationAction(escalation.action),
    triggeredAt: new Date().toISOString(),
  };

  timeoutEvents.push(event);

  log.warn("Timeout escalation triggered", {
    workflowId,
    workflowType,
    currentStep,
    timeoutType,
    action: escalation.action,
    elapsedMs,
  });

  return event;
}

function mapEscalationAction(action: EscalationAction): TimeoutEvent["action"] {
  switch (action) {
    case "alert": return "alerted";
    case "compensate": return "compensated";
    case "extend": return "extended";
    case "notify_admin": return "notified";
  }
}

function findEscalationStep(
  elapsedMs: number,
  escalationSteps: EscalationStep[],
  triggeredActions: Set<string>
): EscalationStep | null {
  for (const step of escalationSteps) {
    if (elapsedMs >= step.atMs && !triggeredActions.has(step.action)) {
      return step;
    }
  }
  return null;
}

// ─── Timeout Analytics ──────────────────────────────────────────────────────

const analyticsData = new Map<string, {
  totalTimeouts: number;
  byType: Record<string, number>;
  timeToTimeouts: number[];
  compensationTriggered: number;
  extensionsGranted: number;
}>();

function recordAnalytics(
  workflowType: string,
  timeoutType: "step" | "workflow",
  elapsedMs: number,
  action: TimeoutEvent["action"]
): void {
  let data = analyticsData.get(workflowType);
  if (!data) {
    data = {
      totalTimeouts: 0,
      byType: {},
      timeToTimeouts: [],
      compensationTriggered: 0,
      extensionsGranted: 0,
    };
    analyticsData.set(workflowType, data);
  }

  data.totalTimeouts++;
  data.byType[timeoutType] = (data.byType[timeoutType] ?? 0) + 1;
  data.timeToTimeouts.push(elapsedMs);

  if (action === "compensated") data.compensationTriggered++;
  if (action === "extended") data.extensionsGranted++;
}

// ─── Main Timeout Handler ───────────────────────────────────────────────────

export class WorkflowTimeoutHandler {
  private readonly stepTracker = new StepTimeoutTracker();
  private readonly triggeredEscalations = new Map<string, Set<string>>();

  /**
   * Starts tracking a step timeout.
   */
  startStepTimeout(workflowId: string, workflowType: string, stepName: string): void {
    const config = getTimeoutConfig(workflowType);
    const stepTimeout = config.stepTimeouts[stepName] ?? 30 * 60 * 1000;
    this.stepTracker.startStep(workflowId, stepName, stepTimeout);
  }

  /**
   * Checks all active step timeouts and triggers escalations as needed.
   * Returns any actions that were triggered.
   */
  checkTimeouts(
    workflowId: string,
    workflowType: string,
    currentStep: string,
    workflowStartedAt: number
  ): TimeoutEvent[] {
    const config = getTimeoutConfig(workflowType);
    const triggered: TimeoutEvent[] = [];

    // Check step-level timeout
    const stepCheck = this.stepTracker.checkStepTimeout(workflowId, currentStep);
    if (stepCheck.timedOut) {
      const escalationKey = `${workflowId}:${currentStep}`;
      const triggeredActions = this.triggeredEscalations.get(escalationKey) ?? new Set();

      const escalation = findEscalationStep(
        stepCheck.elapsedMs,
        config.escalationSteps,
        triggeredActions
      );

      if (escalation) {
        const event = triggerEscalation(
          workflowId,
          workflowType,
          currentStep,
          "step",
          stepCheck.configuredTimeoutMs,
          stepCheck.elapsedMs,
          escalation
        );
        triggered.push(event);
        recordAnalytics(workflowType, "step", stepCheck.elapsedMs, event.action);

        if (!triggeredActions.has(escalation.action)) {
          triggeredActions.add(escalation.action);
          this.triggeredEscalations.set(escalationKey, triggeredActions);
        }
      }
    }

    // Check workflow-level timeout
    const workflowElapsedMs = Date.now() - workflowStartedAt;
    if (workflowElapsedMs >= config.workflowTimeoutMs) {
      const escalationKey = `${workflowId}:workflow`;
      const triggeredActions = this.triggeredEscalations.get(escalationKey) ?? new Set();

      const escalation = findEscalationStep(
        workflowElapsedMs - config.workflowTimeoutMs,
        config.escalationSteps,
        triggeredActions
      );

      if (escalation) {
        const event = triggerEscalation(
          workflowId,
          workflowType,
          currentStep,
          "workflow",
          config.workflowTimeoutMs,
          workflowElapsedMs,
          escalation
        );
        triggered.push(event);
        recordAnalytics(workflowType, "workflow", workflowElapsedMs, event.action);

        if (!triggeredActions.has(escalation.action)) {
          triggeredActions.add(escalation.action);
          this.triggeredEscalations.set(escalationKey, triggeredActions);
        }
      }
    }

    return triggered;
  }

  /**
   * Extends a step timeout (manual override).
   */
  extendStepTimeout(workflowId: string, stepName: string, additionalMs: number): boolean {
    return this.stepTracker.extendStep(workflowId, stepName, additionalMs);
  }

  /**
   * Marks a step as completed and removes its timeout tracking.
   */
  completeStep(workflowId: string, stepName: string): void {
    this.stepTracker.completeStep(workflowId, stepName);
    this.triggeredEscalations.delete(`${workflowId}:${stepName}`);
  }

  /**
   * Gets active step timeout states for a workflow.
   */
  getActiveStepTimeouts(workflowId: string): StepTimeoutState[] {
    return this.stepTracker.getActiveSteps(workflowId);
  }

  /**
   * Gets timeout analytics for a workflow type.
   */
  getAnalytics(workflowType: string): TimeoutAnalytics {
    const data = analyticsData.get(workflowType);
    if (!data) {
      return {
        workflowType,
        totalTimeouts: 0,
        byType: {},
        avgTimeToTimeout: 0,
        compensationTriggered: 0,
        extensionsGranted: 0,
      };
    }

    const avgTimeToTimeout = data.timeToTimeouts.length > 0
      ? data.timeToTimeouts.reduce((a, b) => a + b, 0) / data.timeToTimeouts.length
      : 0;

    return {
      workflowType,
      totalTimeouts: data.totalTimeouts,
      byType: { ...data.byType },
      avgTimeToTimeout,
      compensationTriggered: data.compensationTriggered,
      extensionsGranted: data.extensionsGranted,
    };
  }

  /**
   * Gets all timeout events (for monitoring/dashboard).
   */
  getTimeoutEvents(workflowType?: string): TimeoutEvent[] {
    if (workflowType) return timeoutEvents.filter((e) => e.workflowType === workflowType);
    return [...timeoutEvents];
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let defaultHandler: WorkflowTimeoutHandler | null = null;

export function getWorkflowTimeoutHandler(): WorkflowTimeoutHandler {
  if (!defaultHandler) defaultHandler = new WorkflowTimeoutHandler();
  return defaultHandler;
}

export function resetWorkflowTimeoutHandler(): void {
  defaultHandler = null;
}

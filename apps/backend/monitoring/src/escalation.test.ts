import { describe, it, expect, afterEach } from "vitest";
import type { EscalationPolicy } from "@delegolabs/types";
import {
  createPolicy,
  getPolicy,
  listPolicies,
  updatePolicy,
  deletePolicy,
  startEscalation,
  advanceEscalation,
  recordNotification,
  getActiveEscalation,
  resolveEscalation,
  getEscalationHistory,
} from "./escalation.js";

function makePolicy(overrides: Partial<EscalationPolicy> = {}): EscalationPolicy {
  return {
    id: `policy_${Math.random().toString(36).slice(2)}`,
    name: "Primary Escalation",
    steps: [
      {
        delayMinutes: 0,
        targets: [{ type: "user", id: "user-1" }],
        channels: ["slack"],
      },
      {
        delayMinutes: 15,
        targets: [{ type: "user", id: "user-2" }],
        channels: ["pagerduty", "sms"],
      },
    ],
    ...overrides,
  };
}

describe("escalation", () => {
  const createdPolicyIds: string[] = [];
  const activeAlertIds: string[] = [];

  afterEach(() => {
    for (const alertId of activeAlertIds.splice(0)) {
      resolveEscalation(alertId);
    }
    for (const id of createdPolicyIds.splice(0)) {
      deletePolicy(id);
    }
  });

  describe("policy CRUD", () => {
    it("creates, retrieves, lists, updates, and deletes policies", () => {
      const policy = makePolicy({ id: "pol-crud-1", name: "On-Call Policy" });
      createdPolicyIds.push(policy.id);

      expect(createPolicy(policy)).toEqual(policy);
      expect(getPolicy(policy.id)).toEqual(policy);
      expect(listPolicies().some((p) => p.id === policy.id)).toBe(true);

      const updated = updatePolicy(policy.id, { name: "Renamed Policy", id: "ignored" });
      expect(updated?.name).toBe("Renamed Policy");
      expect(updated?.id).toBe(policy.id);

      expect(updatePolicy("missing-policy", { name: "Nope" })).toBeNull();
      expect(deletePolicy(policy.id)).toBe(true);
      expect(getPolicy(policy.id)).toBeNull();
      expect(deletePolicy(policy.id)).toBe(false);
    });
  });

  describe("escalation lifecycle", () => {
    it("returns null when starting escalation for missing or empty policy", () => {
      expect(startEscalation("alert-missing", "no-such-policy")).toBeNull();

      const emptyPolicy = makePolicy({ id: "pol-empty", steps: [] });
      createdPolicyIds.push(emptyPolicy.id);
      createPolicy(emptyPolicy);

      expect(startEscalation("alert-empty", emptyPolicy.id)).toBeNull();
    });

    it("starts, advances through steps, and completes when reaching the end", () => {
      const policy = makePolicy({ id: "pol-flow-1" });
      createdPolicyIds.push(policy.id);
      createPolicy(policy);

      const alertId = "alert-flow-1";
      activeAlertIds.push(alertId);

      const started = startEscalation(alertId, policy.id);
      expect(started).toEqual({
        step: 0,
        targets: [{ type: "user", id: "user-1" }],
        channels: ["slack"],
      });
      expect(getActiveEscalation(alertId)?.currentStep).toBe(0);

      const step1 = advanceEscalation(alertId);
      expect(step1).toEqual({
        step: 1,
        targets: [{ type: "user", id: "user-2" }],
        channels: ["pagerduty", "sms"],
        done: false,
      });
      expect(getActiveEscalation(alertId)?.currentStep).toBe(1);

      const done = advanceEscalation(alertId);
      expect(done).toEqual({
        step: 2,
        targets: [],
        channels: [],
        done: true,
      });
      expect(getActiveEscalation(alertId)).toBeNull();
      expect(advanceEscalation(alertId)).toBeNull();
    });

    it("loops back to step 0 when the final step has repeat and repeatIntervalMinutes", () => {
      const repeatingPolicy = makePolicy({
        id: "pol-repeat-1",
        steps: [
          {
            delayMinutes: 0,
            targets: [{ type: "user", id: "user-repeat" }],
            channels: ["pagerduty"],
            repeat: true,
            repeatIntervalMinutes: 10,
          },
        ],
      });
      createdPolicyIds.push(repeatingPolicy.id);
      createPolicy(repeatingPolicy);

      const alertId = "alert-repeat-1";
      activeAlertIds.push(alertId);

      startEscalation(alertId, repeatingPolicy.id);
      const repeated = advanceEscalation(alertId);
      expect(repeated).toEqual({
        step: 0,
        targets: [{ type: "user", id: "user-repeat" }],
        channels: ["pagerduty"],
        done: false,
      });
      expect(getActiveEscalation(alertId)?.currentStep).toBe(0);
    });

    it("records notification history and resolves active escalations", () => {
      const policy = makePolicy({ id: "pol-notify-1" });
      createdPolicyIds.push(policy.id);
      createPolicy(policy);

      const alertId = "alert-notify-1";
      activeAlertIds.push(alertId);

      // Recording for non-existent escalation is a no-op
      recordNotification("unknown-alert", 0, "slack", "user-1", "sent");
      expect(getEscalationHistory("unknown-alert")).toEqual([]);

      startEscalation(alertId, policy.id);
      recordNotification(alertId, 0, "slack", "user-1", "sent");
      recordNotification(alertId, 0, "sms", "user-1", "failed");

      const history = getEscalationHistory(alertId);
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({
        step: 0,
        channel: "slack",
        targetId: "user-1",
        status: "sent",
      });
      expect(history[1]).toMatchObject({
        step: 0,
        channel: "sms",
        targetId: "user-1",
        status: "failed",
      });

      expect(resolveEscalation(alertId)).toBe(true);
      expect(resolveEscalation(alertId)).toBe(false);
      expect(getActiveEscalation(alertId)).toBeNull();
    });
  });
});

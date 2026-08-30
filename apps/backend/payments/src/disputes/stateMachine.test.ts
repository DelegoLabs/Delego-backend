import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, isTerminal, planAdvance, stageIndex } from "./stateMachine.js";
import { InvalidStateTransitionError } from "./types.js";

describe("dispute state machine", () => {
  it("allows each forward step in the documented lifecycle", () => {
    expect(canTransition("open", "evidence_collection")).toBe(true);
    expect(canTransition("evidence_collection", "negotiation")).toBe(true);
    expect(canTransition("negotiation", "decided")).toBe(true);
    expect(canTransition("decided", "resolved")).toBe(true);
  });

  it("allows self-loops (no-op re-entry into the same state)", () => {
    expect(canTransition("open", "open")).toBe(true);
    expect(canTransition("negotiation", "negotiation")).toBe(true);
    expect(canTransition("resolved", "resolved")).toBe(true);
  });

  it("rejects skipping a stage", () => {
    expect(canTransition("open", "negotiation")).toBe(false);
    expect(canTransition("open", "decided")).toBe(false);
    expect(canTransition("evidence_collection", "decided")).toBe(false);
    expect(canTransition("evidence_collection", "resolved")).toBe(false);
  });

  it("rejects moving backwards", () => {
    expect(canTransition("negotiation", "open")).toBe(false);
    expect(canTransition("decided", "negotiation")).toBe(false);
    expect(canTransition("resolved", "decided")).toBe(false);
  });

  it("rejects any transition out of the terminal 'resolved' state", () => {
    expect(canTransition("resolved", "open")).toBe(false);
    expect(canTransition("resolved", "negotiation")).toBe(false);
    expect(isTerminal("resolved")).toBe(true);
    expect(isTerminal("decided")).toBe(false);
  });

  it("assertTransition throws InvalidStateTransitionError with from/to on illegal moves", () => {
    expect(() => assertTransition("open", "decided")).toThrow(InvalidStateTransitionError);
    try {
      assertTransition("open", "decided");
      throw new Error("should not reach");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidStateTransitionError);
      expect((err as InvalidStateTransitionError).from).toBe("open");
      expect((err as InvalidStateTransitionError).to).toBe("decided");
    }
  });

  it("stageIndex orders the lifecycle stages", () => {
    expect(stageIndex("open")).toBeLessThan(stageIndex("evidence_collection"));
    expect(stageIndex("evidence_collection")).toBeLessThan(stageIndex("negotiation"));
    expect(stageIndex("negotiation")).toBeLessThan(stageIndex("decided"));
    expect(stageIndex("decided")).toBeLessThan(stageIndex("resolved"));
  });

  describe("planAdvance", () => {
    it("returns an empty plan for a no-op advance", () => {
      expect(planAdvance("negotiation", "negotiation")).toEqual([]);
    });

    it("plans every intermediate hop when fast-tracking forward", () => {
      const steps = planAdvance("open", "negotiation");
      expect(steps).toEqual([
        { from: "open", to: "evidence_collection" },
        { from: "evidence_collection", to: "negotiation" },
      ]);
    });

    it("throws when the target is behind the current stage", () => {
      expect(() => planAdvance("negotiation", "open")).toThrow(InvalidStateTransitionError);
    });
  });
});

// Issue #116 — Tests for the translator collaboration workflow.
import { describe, it, expect } from "vitest";
import { TranslationWorkflow, InvalidTransitionError } from "./translator.js";

describe("TranslationWorkflow", () => {
  it("creates a pending job", () => {
    const workflow = new TranslationWorkflow();
    const job = workflow.create({
      templateId: "escrow_released",
      sourceLocale: "en",
      targetLocales: ["es", "fr"],
      assignedTo: "translator-1",
      dueDate: "2026-09-01",
    });
    expect(job.status).toBe("pending");
    expect(workflow.get(job.id)).toBeDefined();
  });

  it("supports the happy-path lifecycle", () => {
    const workflow = new TranslationWorkflow();
    const job = workflow.create({
      templateId: "t",
      sourceLocale: "en",
      targetLocales: ["de"],
      assignedTo: "t1",
      dueDate: "",
    });
    workflow.assign(job.id, "t1");
    workflow.start(job.id);
    expect(workflow.get(job.id)!.status).toBe("in_progress");
    workflow.submitForReview(job.id);
    expect(workflow.get(job.id)!.status).toBe("review");
    workflow.approve(job.id);
    expect(workflow.get(job.id)!.status).toBe("approved");
    workflow.publish(job.id);
    expect(workflow.get(job.id)!.status).toBe("published");
  });

  it("rejects invalid transitions", () => {
    const workflow = new TranslationWorkflow();
    const job = workflow.create({
      templateId: "t",
      sourceLocale: "en",
      targetLocales: ["de"],
      assignedTo: "t1",
      dueDate: "",
    });
    expect(() => workflow.publish(job.id)).toThrow(InvalidTransitionError);
    expect(() => workflow.transition(job.id, "bogus" as never)).toThrow();
  });

  it("allows a reviewer to send work back", () => {
    const workflow = new TranslationWorkflow();
    const job = workflow.create({
      templateId: "t",
      sourceLocale: "en",
      targetLocales: ["de"],
      assignedTo: "t1",
      dueDate: "",
    });
    workflow.start(job.id);
    workflow.submitForReview(job.id);
    workflow.transition(job.id, "in_progress");
    expect(workflow.get(job.id)!.status).toBe("in_progress");
  });

  it("supports cancellation from pending/in_progress/review", () => {
    const workflow = new TranslationWorkflow();
    const job = workflow.create({
      templateId: "t",
      sourceLocale: "en",
      targetLocales: ["de"],
      assignedTo: "t1",
      dueDate: "",
    });
    workflow.start(job.id);
    workflow.transition(job.id, "cancelled");
    expect(workflow.get(job.id)!.status).toBe("cancelled");
    expect(() => workflow.publish(job.id)).toThrow(InvalidTransitionError);
  });

  it("lists jobs by status and assignee", () => {
    const workflow = new TranslationWorkflow();
    const a = workflow.create({ templateId: "t1", sourceLocale: "en", targetLocales: ["es"], assignedTo: "t1", dueDate: "" });
    const b = workflow.create({ templateId: "t2", sourceLocale: "en", targetLocales: ["fr"], assignedTo: "t2", dueDate: "" });
    workflow.start(a.id);
    expect(workflow.listByStatus("pending").map((j) => j.id)).toEqual([b.id]);
    expect(workflow.listAssignedTo("t1").map((j) => j.id)).toEqual([a.id]);
  });

  it("throws when a job does not exist", () => {
    const workflow = new TranslationWorkflow();
    expect(workflow.get("missing")).toBeUndefined();
    expect(() => workflow.assign("missing", "x")).toThrow();
  });
});

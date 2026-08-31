// Issue #116 — Translator collaboration workflow. Models translation jobs and
// their lifecycle (pending → in_progress → review → approved → published) so
// translators can coordinate work on a template without stepping on each other.

import type { TranslationJob, TranslationJobStatus } from "./types.js";

const VALID_TRANSITIONS: Record<TranslationJobStatus, TranslationJobStatus[]> = {
  pending: ["in_progress", "cancelled", "review"],
  in_progress: ["review", "cancelled"],
  review: ["in_progress", "approved", "cancelled"],
  approved: ["review", "published", "in_progress"],
  published: [],
  cancelled: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Invalid translation job transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

let jobSeq = 0;

function generateId(): string {
  jobSeq += 1;
  return `tj_${Date.now().toString(36)}_${jobSeq}`;
}

/** In-memory translation job store + workflow. */
export class TranslationWorkflow {
  private jobs = new Map<string, TranslationJob>();

  create(input: Omit<TranslationJob, "id" | "status" | "createdAt">): TranslationJob {
    const job: TranslationJob = {
      ...input,
      id: generateId(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): TranslationJob | undefined {
    return this.jobs.get(id);
  }

  list(): TranslationJob[] {
    return [...this.jobs.values()];
  }

  listByStatus(status: TranslationJobStatus): TranslationJob[] {
    return this.list().filter((j) => j.status === status);
  }

  listAssignedTo(user: string): TranslationJob[] {
    return this.list().filter((j) => j.assignedTo === user);
  }

  assign(id: string, assignee: string): TranslationJob {
    const job = this.requireJob(id);
    job.assignedTo = assignee;
    return job;
  }

  transition(id: string, next: TranslationJobStatus): TranslationJob {
    const job = this.requireJob(id);
    const allowed = VALID_TRANSITIONS[job.status];
    if (!allowed.includes(next)) {
      throw new InvalidTransitionError(job.status, next);
    }
    job.status = next;
    return job;
  }

  /** Start work on a pending job. */
  start(id: string): TranslationJob {
    return this.transition(id, "in_progress");
  }

  submitForReview(id: string): TranslationJob {
    return this.transition(id, "review");
  }

  approve(id: string): TranslationJob {
    return this.transition(id, "approved");
  }

  publish(id: string): TranslationJob {
    return this.transition(id, "published");
  }

  private requireJob(id: string): TranslationJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Translation job not found: ${id}`);
    return job;
  }
}

/** Shared singleton used across the notification service. */
export const translationWorkflow = new TranslationWorkflow();

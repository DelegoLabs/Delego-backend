import type { ArchiveRunResult } from "./types.js";
import type { EscrowArchiver } from "./escrowArchiver.js";
import {
  startEscrowArchiveScheduler,
  type EscrowArchiveSchedulerOptions,
} from "./scheduler.js";

export type ArchivalCronOptions = EscrowArchiveSchedulerOptions;
export type ArchivalCronResult = ArchiveRunResult;

/** Runs one archival pass immediately. */
export function archiveCompletedEscrows(
  archiver: EscrowArchiver,
  now?: Date
): Promise<ArchivalCronResult> {
  return archiver.runOnce(now);
}

/** Starts the daily archival schedule and returns its stop function. */
export function runArchivalCron(
  archiver: EscrowArchiver,
  options: ArchivalCronOptions = {}
): () => void {
  return startEscrowArchiveScheduler(archiver, options);
}

/**
 * Issue #146 — Workflow state migration tool types.
 *
 * Defines the data structures for migrating in-flight workflows
 * between versions safely.
 */

export type MigrationStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "rolled_back";

export type InstanceMigrationStatus =
  | "pending"
  | "completed"
  | "failed"
  | "skipped";

export type StateMappingAction = "map" | "split" | "merge" | "remove" | "add";

export type ContextTransformOperation = "add" | "remove" | "replace" | "move" | "copy";

// ─── Migration Plan ─────────────────────────────────────────────────────────

export interface StateMapping {
  fromState: string;
  toState: string;
  action: StateMappingAction;
  /** For "split" action: maps to multiple target states */
  splitTargets?: string[];
  /** For "merge" action: source states to merge from */
  mergeSources?: string[];
}

export interface ContextTransform {
  path: string;
  operation: ContextTransformOperation;
  value?: unknown;
  /** For "move" operation: destination path */
  moveTo?: string;
  /** For "copy" operation: destination path */
  copyTo?: string;
}

export interface MigrationPlan {
  workflowType: string;
  fromVersion: string;
  toVersion: string;
  stateMappings: StateMapping[];
  contextTransforms: ContextTransform[];
  safetyChecks: string[];
  estimatedDurationMs: number;
}

// ─── Migration Instance ─────────────────────────────────────────────────────

export interface MigrationInstance {
  instanceId: string;
  fromState: string;
  toState: string;
  contextTransform: string;
  status: InstanceMigrationStatus;
  error?: string;
  migratedAt?: string;
}

// ─── Migration Execution ────────────────────────────────────────────────────

export interface WorkflowMigration {
  id: string;
  workflowType: string;
  fromVersion: string;
  toVersion: string;
  status: MigrationStatus;
  migrations: MigrationInstance[];
  dryRun: boolean;
  startedAt: string;
  completedAt?: string;
  rolledBackAt?: string;
  totalInstances: number;
  migratedCount: number;
  failedCount: number;
  skippedCount: number;
  durationMs: number;
  errors: Array<{ instanceId: string; error: string }>;
}

// ─── Migration Result ───────────────────────────────────────────────────────

export interface MigrationResult {
  migrationId: string;
  totalInstances: number;
  migrated: number;
  failed: number;
  skipped: number;
  durationMs: number;
  errors: Array<{ instanceId: string; error: string }>;
}

// ─── Migration Audit Log ────────────────────────────────────────────────────

export interface MigrationAuditEntry {
  id: string;
  migrationId: string;
  instanceId: string;
  action: "migrate" | "rollback" | "skip" | "fail";
  fromState: string;
  toState: string;
  contextBefore: Record<string, unknown>;
  contextAfter: Record<string, unknown>;
  timestamp: string;
  durationMs: number;
  error?: string;
  operator?: string;
}

// ─── Version Diff ───────────────────────────────────────────────────────────

export interface WorkflowVersionDiff {
  workflowType: string;
  fromVersion: string;
  toVersion: string;
  addedStates: string[];
  removedStates: string[];
  renamedStates: Array<{ from: string; to: string }>;
  modifiedStates: string[];
  addedContextFields: string[];
  removedContextFields: string[];
}

// ─── Safety Check ───────────────────────────────────────────────────────────

export type SafetyCheckResult = {
  check: string;
  passed: boolean;
  message: string;
  severity: "info" | "warning" | "error";
};

export interface SafetyCheckReport {
  allPassed: boolean;
  results: SafetyCheckResult[];
  canProceed: boolean;
}

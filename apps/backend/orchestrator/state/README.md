# Orchestrator State

Workflow checkpoints and recovery.

`WorkflowStateStore` in `types.ts` is the persistence contract used by
`SagaCoordinator`. It stores versioned saga checkpoints, supports resuming
incomplete or expired workflows, and appends ordered audit events.

- `PostgresWorkflowStateStore` persists checkpoints and events in the
  `saga_executions` and `saga_events` tables.
- `InMemoryWorkflowStateStore` provides the same contract for unit tests and
  local development.
- `SagaStore`, `PostgresSagaStore`, and `InMemorySagaStore` remain as
  backwards-compatible aliases.
- Redis remains responsible for distributed locks and the active-session cache;
  PostgreSQL is the durable checkpoint store.

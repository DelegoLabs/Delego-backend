# Orchestrator Execution

`StepRunner` executes typed workflow steps in order. Each step can configure a
bounded retry policy with exponential backoff. Set `leaseDeadlineMs` to an
absolute Unix timestamp in milliseconds to prevent starting another step or
retry delay that would cross the runner's lease deadline.

When a forward step fails, the runner compensates completed steps in reverse
order. It continues attempting remaining compensations if one fails and returns
a `StepRunnerResult` with the forward failure, successful compensations, and any
rollback failures. A fully successful rollback has status `compensated`; an
incomplete rollback has status `partial_failure`.

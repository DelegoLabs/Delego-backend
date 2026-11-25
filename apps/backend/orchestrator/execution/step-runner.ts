export interface StepRetryPolicy {
  /** Total attempts, including the initial attempt. */
  maxAttempts: number;
  /** Initial delay between attempts; subsequent delays grow exponentially. */
  backoffMs: number;
  /** Maximum delay between attempts. Defaults to max(backoffMs, 5 seconds). */
  maxBackoffMs?: number;
  /** When provided, retry only errors whose messages contain one of these strings. */
  retryableErrors?: readonly string[];
}

export interface StepRunnerOptions {
  /** Absolute Unix timestamp in milliseconds after which no retries are started. */
  leaseDeadlineMs?: number;
  /** Injectable clock and sleep for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WorkflowStep<TContext> {
  name: string;
  execute(context: TContext): Promise<TContext>;
  compensate(context: TContext, cause: Error): Promise<TContext>;
  retryPolicy?: StepRetryPolicy;
}

export interface StepCompensationFailure {
  step: string;
  error: string;
}

export interface StepRunnerResult<TContext> {
  status: "completed" | "compensated" | "partial_failure";
  context: TContext;
  /** Successfully executed steps, in forward order. */
  completedSteps: string[];
  /** Successfully compensated steps, in reverse execution order. */
  compensatedSteps: string[];
  failedCompensations: StepCompensationFailure[];
  /** The forward step that failed, when rollback was triggered. */
  failure?: { step: string; error: string };
}

export class NonRetryableStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableStepError";
  }
}

export class StepLeaseDeadlineError extends Error {
  constructor() {
    super("Step lease deadline reached before the next step could start");
    this.name = "StepLeaseDeadlineError";
  }
}

/** Runs an operation with bounded exponential backoff and an optional lease deadline. */
export async function runWithBoundedRetry<T>(
  operation: () => Promise<T>,
  policy?: StepRetryPolicy,
  options: StepRunnerOptions = {},
): Promise<T> {
  validateRetryPolicy(policy);
  validateDeadline(options.leaseDeadlineMs);

  const maxAttempts = policy?.maxAttempts ?? 1;
  const baseDelayMs = policy?.backoffMs ?? 0;
  const maxBackoffMs = policy?.maxBackoffMs ?? Math.max(baseDelayMs, 5000);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (
      attempt > 1 &&
      options.leaseDeadlineMs !== undefined &&
      now() >= options.leaseDeadlineMs
    ) {
      throw lastError ?? new StepLeaseDeadlineError();
    }

    try {
      return await operation();
    } catch (err) {
      const error = toError(err);
      lastError = error;
      if (
        !policy ||
        error instanceof NonRetryableStepError ||
        attempt === maxAttempts ||
        (policy.retryableErrors !== undefined &&
          !policy.retryableErrors.some((pattern) => error.message.includes(pattern)))
      ) {
        throw error;
      }

      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxBackoffMs);
      if (
        options.leaseDeadlineMs !== undefined &&
        now() + delayMs >= options.leaseDeadlineMs
      ) {
        throw error;
      }

      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("Retry policy exhausted without an operation result");
}

/**
 * Executes steps in order. A forward failure stops execution and compensates
 * completed steps in reverse order, continuing cleanup if a compensation fails.
 */
export class StepRunner<TContext> {
  private readonly now: () => number;

  constructor(
    private readonly steps: readonly WorkflowStep<TContext>[],
    private readonly options: StepRunnerOptions = {},
  ) {
    const names = new Set<string>();
    for (const step of steps) {
      if (!step.name || names.has(step.name)) {
        throw new Error(`Step names must be non-empty and unique: "${step.name}"`);
      }
      names.add(step.name);
      validateRetryPolicy(step.retryPolicy);
    }
    validateDeadline(options.leaseDeadlineMs);
    this.now = options.now ?? Date.now;
  }

  async run(initialContext: TContext): Promise<StepRunnerResult<TContext>> {
    const completed: WorkflowStep<TContext>[] = [];
    let context = initialContext;

    for (const step of this.steps) {
      try {
        if (
          this.options.leaseDeadlineMs !== undefined &&
          this.now() >= this.options.leaseDeadlineMs
        ) {
          throw new StepLeaseDeadlineError();
        }
        context = await runWithBoundedRetry(
          () => step.execute(context),
          step.retryPolicy,
          this.options,
        );
        completed.push(step);
      } catch (err) {
        const cause = toError(err);
        const rollback = await this.compensate(completed, context, cause);
        return {
          status: rollback.failedCompensations.length === 0 ? "compensated" : "partial_failure",
          context: rollback.context,
          completedSteps: completed.map(({ name }) => name),
          compensatedSteps: rollback.compensatedSteps,
          failedCompensations: rollback.failedCompensations,
          failure: { step: step.name, error: cause.message },
        };
      }
    }

    return {
      status: "completed",
      context,
      completedSteps: completed.map(({ name }) => name),
      compensatedSteps: [],
      failedCompensations: [],
    };
  }

  private async compensate(
    completed: readonly WorkflowStep<TContext>[],
    context: TContext,
    cause: Error,
  ): Promise<{
    context: TContext;
    compensatedSteps: string[];
    failedCompensations: StepCompensationFailure[];
  }> {
    const compensatedSteps: string[] = [];
    const failedCompensations: StepCompensationFailure[] = [];
    let currentContext = context;

    for (const step of [...completed].reverse()) {
      try {
        currentContext = await runWithBoundedRetry(
          () => step.compensate(currentContext, cause),
          step.retryPolicy,
          this.options,
        );
        compensatedSteps.push(step.name);
      } catch (err) {
        failedCompensations.push({ step: step.name, error: toError(err).message });
      }
    }

    return { context: currentContext, compensatedSteps, failedCompensations };
  }
}

function validateRetryPolicy(policy: StepRetryPolicy | undefined): void {
  if (!policy) return;
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive safe integer");
  }
  if (!Number.isFinite(policy.backoffMs) || policy.backoffMs < 0) {
    throw new RangeError("backoffMs must be a non-negative finite number");
  }
  if (
    policy.maxBackoffMs !== undefined &&
    (!Number.isFinite(policy.maxBackoffMs) || policy.maxBackoffMs < 0)
  ) {
    throw new RangeError("maxBackoffMs must be a non-negative finite number");
  }
}

function validateDeadline(deadlineMs: number | undefined): void {
  if (deadlineMs !== undefined && !Number.isFinite(deadlineMs)) {
    throw new RangeError("leaseDeadlineMs must be a finite timestamp");
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

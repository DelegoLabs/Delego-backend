// Issue #50 — Event-driven choreography for workflow coordination

import { randomUUID } from "node:crypto";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("orchestrator:event-choreography", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Event schema types
// ---------------------------------------------------------------------------

export interface WorkflowEvent {
  eventId: string;
  correlationId: string;
  causationId?: string;
  workflowType: string;
  workflowInstanceId: string;
  eventType: string;
  payload: Record<string, unknown>;
  metadata: {
    sourceService: string;
    version: string;
    timestamp: string;
  };
}

export interface EventSubscription {
  id: string;
  serviceName: string;
  eventTypes: string[];
  handler: (event: WorkflowEvent) => Promise<void>;
  filter?: Record<string, unknown>;
  retryPolicy: {
    maxAttempts: number;
    backoffMs: number;
    deadLetterAfter: number;
  };
}

export interface OutboxEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  correlationId: string;
  createdAt: string;
  publishedAt?: string;
  attempts: number;
  lastError?: string;
}

export interface EventSchema {
  eventType: string;
  version: string;
  schema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Schema registry
// ---------------------------------------------------------------------------

const schemaRegistry = new Map<string, EventSchema>();

export function registerEventSchema(schema: EventSchema): void {
  const key = `${schema.eventType}:${schema.version}`;
  schemaRegistry.set(key, schema);
  log.info("Event schema registered", { eventType: schema.eventType, version: schema.version });
}

export function getEventSchema(eventType: string, version: string): EventSchema | undefined {
  return schemaRegistry.get(`${eventType}:${version}`);
}

export function validateEventPayload(eventType: string, version: string, payload: Record<string, unknown>): boolean {
  const schema = getEventSchema(eventType, version);
  if (!schema) return true; // No schema = no validation
  // Basic validation: check required fields exist
  const required = (schema.schema as any)?.required as string[] | undefined;
  if (required) {
    return required.every((field) => field in payload);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Dead letter queue
// ---------------------------------------------------------------------------

export interface DeadLetterEntry {
  event: WorkflowEvent;
  error: string;
  attempts: number;
  failedAt: string;
}

const deadLetterQueue: DeadLetterEntry[] = [];

export function addToDeadLetterQueue(event: WorkflowEvent, error: string, attempts: number): void {
  deadLetterQueue.push({ event, error, attempts, failedAt: new Date().toISOString() });
  log.warn("Event added to dead letter queue", { eventId: event.eventId, eventType: event.eventType, attempts });
}

export function getDeadLetterQueue(): readonly DeadLetterEntry[] {
  return deadLetterQueue;
}

export function clearDeadLetterQueue(): void {
  deadLetterQueue.length = 0;
}

// ---------------------------------------------------------------------------
// Event ordering (per correlation ID)
// ---------------------------------------------------------------------------

const correlationSequences = new Map<string, number>();

export function getNextSequenceNumber(correlationId: string): number {
  const current = correlationSequences.get(correlationId) ?? 0;
  const next = current + 1;
  correlationSequences.set(correlationId, next);
  return next;
}

export function resetSequenceNumbers(): void {
  correlationSequences.clear();
}

// ---------------------------------------------------------------------------
// Subscription registry
// ---------------------------------------------------------------------------

const subscriptions = new Map<string, EventSubscription>();

export function subscribe(subscription: EventSubscription): void {
  subscriptions.set(subscription.id, subscription);
  log.info("Event subscription registered", {
    id: subscription.id,
    service: subscription.serviceName,
    eventTypes: subscription.eventTypes,
  });
}

export function unsubscribe(subscriptionId: string): void {
  subscriptions.delete(subscriptionId);
}

export function getSubscriptions(): EventSubscription[] {
  return [...subscriptions.values()];
}

// ---------------------------------------------------------------------------
// Event creation
// ---------------------------------------------------------------------------

export function createWorkflowEvent(params: {
  correlationId: string;
  causationId?: string;
  workflowType: string;
  workflowInstanceId: string;
  eventType: string;
  payload: Record<string, unknown>;
  sourceService: string;
  version?: string;
}): WorkflowEvent {
  return {
    eventId: randomUUID(),
    correlationId: params.correlationId,
    causationId: params.causationId,
    workflowType: params.workflowType,
    workflowInstanceId: params.workflowInstanceId,
    eventType: params.eventType,
    payload: params.payload,
    metadata: {
      sourceService: params.sourceService,
      version: params.version ?? "1.0.0",
      timestamp: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Event publishing with choreography dispatch
// ---------------------------------------------------------------------------

const publishedEvents: WorkflowEvent[] = [];

export async function publishEvent(event: WorkflowEvent): Promise<void> {
  // Validate against schema
  if (!validateEventPayload(event.eventType, event.metadata.version, event.payload)) {
    log.warn("Event failed schema validation", { eventId: event.eventId, eventType: event.eventType });
    addToDeadLetterQueue(event, "Schema validation failed", 0);
    return;
  }

  publishedEvents.push(event);
  log.info("Event published", {
    eventId: event.eventId,
    eventType: event.eventType,
    correlationId: event.correlationId,
  });

  // Dispatch to matching subscriptions
  const matching = [...subscriptions.values()].filter((sub) =>
    sub.eventTypes.includes(event.eventType)
  );

  for (const sub of matching) {
    if (sub.filter && !matchesFilter(event, sub.filter)) continue;
    await dispatchToSubscriber(sub, event);
  }
}

async function dispatchToSubscriber(sub: EventSubscription, event: WorkflowEvent): Promise<void> {
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= sub.retryPolicy.maxAttempts; attempt++) {
    try {
      await sub.handler(event);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn("Event handler failed", {
        subscriptionId: sub.id,
        eventId: event.eventId,
        attempt,
        error: lastError,
      });
      if (attempt < sub.retryPolicy.maxAttempts) {
        const delay = sub.retryPolicy.backoffMs * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  if (sub.retryPolicy.deadLetterAfter > 0) {
    addToDeadLetterQueue(event, lastError ?? "Unknown error", sub.retryPolicy.maxAttempts);
  }
}

function matchesFilter(event: WorkflowEvent, filter: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if ((event.payload as any)[key] !== value) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Event replay for recovery
// ---------------------------------------------------------------------------

export function getPublishedEvents(): readonly WorkflowEvent[] {
  return publishedEvents;
}

export function clearPublishedEvents(): void {
  publishedEvents.length = 0;
}

export function replayEvents(events: WorkflowEvent[]): void {
  for (const event of events) {
    publishedEvents.push(event);
  }
  log.info("Events replayed", { count: events.length });
}

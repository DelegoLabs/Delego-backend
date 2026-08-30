import {
  SagaConcurrencyError,
  type SagaEvent,
  type SagaRecord,
  type SagaStore,
} from "./types.js";

function clone(record: SagaRecord): SagaRecord {
  return {
    ...record,
    completedSteps: record.completedSteps.map((step) => ({ ...step, output: { ...step.output } })),
    context: structuredClone(record.context),
    correlationId: record.correlationId,
    error: record.error,
    expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
    claimExpiresAt: record.claimExpiresAt ? new Date(record.claimExpiresAt) : null,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function cloneEvent(event: SagaEvent): SagaEvent {
  return {
    ...event,
    payload: structuredClone(event.payload),
    createdAt: new Date(event.createdAt),
  };
}

/** Non-durable SagaStore — used in unit tests and local development without Postgres. */
export class InMemorySagaStore implements SagaStore {
  private readonly records = new Map<string, SagaRecord>();
  private readonly events: SagaEvent[] = [];

  async create(record: SagaRecord): Promise<SagaRecord> {
    const existing = this.records.get(record.sagaId);
    if (existing) return clone(existing);
    const stored = clone({ ...record, version: 0 });
    this.records.set(record.sagaId, stored);
    return clone(stored);
  }

  async createIfNotExists(record: SagaRecord): Promise<SagaRecord> {
    return this.create(record);
  }

  async get(sagaId: string): Promise<SagaRecord | null> {
    const record = this.records.get(sagaId);
    return record ? clone(record) : null;
  }

  async save(record: SagaRecord): Promise<SagaRecord> {
    const existing = this.records.get(record.sagaId);
    if (!existing || existing.version !== record.version) {
      throw new SagaConcurrencyError(record.sagaId);
    }
    const updated = clone({ ...record, version: record.version + 1 });
    this.records.set(record.sagaId, updated);
    return clone(updated);
  }

  async listIncomplete(): Promise<SagaRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.status === "running" || record.status === "compensating")
      .map(clone);
  }

  async listTimedOut(): Promise<SagaRecord[]> {
    const now = Date.now();
    return [...this.records.values()]
      .filter(
        (record) =>
          (record.status === "running" || record.status === "compensating") &&
          record.expiresAt !== null &&
          record.expiresAt.getTime() <= now
      )
      .map(clone);
  }

  async appendEvent(event: SagaEvent): Promise<void> {
    this.events.push(cloneEvent(event));
  }

  async getEvents(sagaId: string): Promise<SagaEvent[]> {
    return this.events.filter((event) => event.sagaId === sagaId).map(cloneEvent);
  }

  async findByCorrelationId(correlationId: string): Promise<SagaRecord | null> {
    for (const record of this.records.values()) {
      if (record.correlationId === correlationId) return clone(record);
    }
    return null;
  }
}

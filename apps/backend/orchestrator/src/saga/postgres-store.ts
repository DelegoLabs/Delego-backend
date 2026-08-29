import { DataTypes, Model, Op, Optional, Sequelize } from "sequelize";
import { createLogger } from "@delegolabs/utils";
import {
  SagaConcurrencyError,
  type SagaEvent,
  type SagaRecord,
  type SagaStatus,
  type SagaStore,
  type SagaWorkflowType,
} from "./types.js";
import { validateSagaContext } from "./validation.js";

const log = createLogger("orchestrator:saga:store", process.env.LOG_LEVEL ?? "info");

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";

const NON_NEGATIVE_INTEGER_PATTERN = /^(0|[1-9]\d*)$/;

function parsePoolSize(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;

  if (!NON_NEGATIVE_INTEGER_PATTERN.test(raw)) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return Number(raw);
}

const poolMin = parsePoolSize("DATABASE_POOL_MIN", 2);
const poolMax = parsePoolSize("DATABASE_POOL_MAX", 10);
if (poolMin > poolMax) {
  throw new Error("DATABASE_POOL_MIN must be less than or equal to DATABASE_POOL_MAX");
}

export const sequelize = new Sequelize(databaseUrl, {
  dialect: "postgres",
  logging: (msg) => log.debug(msg),
  pool: {
    min: poolMin,
    max: poolMax,
    acquire: 30000,
    idle: 10000,
  },
  define: {
    underscored: true,
    timestamps: true,
  },
});

interface SagaExecutionAttributes {
  sagaId: string;
  orderId: string;
  workflowType: SagaWorkflowType;
  status: SagaStatus;
  currentStep: string | null;
  completedSteps: import("./types.js").CompletedStep[];
  context: Record<string, unknown>;
  correlationId: string | null;
  error: string | null;
  version: number;
  expiresAt: Date | null;
  claimExpiresAt: Date | null;
}

class SagaExecutionModel extends Model<SagaExecutionAttributes> implements SagaExecutionAttributes {
  declare sagaId: string;
  declare orderId: string;
  declare workflowType: SagaWorkflowType;
  declare status: SagaStatus;
  declare currentStep: string | null;
  declare completedSteps: import("./types.js").CompletedStep[];
  declare context: Record<string, unknown>;
  declare correlationId: string | null;
  declare error: string | null;
  declare version: number;
  declare expiresAt: Date | null;
  declare claimExpiresAt: Date | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

SagaExecutionModel.init(
  {
    sagaId: { type: DataTypes.STRING(128), primaryKey: true, field: "saga_id" },
    orderId: { type: DataTypes.STRING(128), allowNull: false, field: "order_id" },
    workflowType: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: "checkout",
      field: "workflow_type",
    },
    status: { type: DataTypes.STRING(32), allowNull: false },
    currentStep: { type: DataTypes.STRING(128), allowNull: true, field: "current_step" },
    completedSteps: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
      field: "completed_steps",
    },
    context: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    correlationId: { type: DataTypes.STRING(128), allowNull: true, field: "correlation_id" },
    error: { type: DataTypes.TEXT, allowNull: true },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    expiresAt: { type: DataTypes.DATE, allowNull: true, field: "expires_at" },
    claimExpiresAt: { type: DataTypes.DATE, allowNull: true, field: "claim_expires_at" },
  },
  {
    sequelize,
    modelName: "SagaExecution",
    tableName: "saga_executions",
  }
);

interface SagaEventAttributes {
  id: number;
  sagaId: string;
  correlationId: string | null;
  eventType: string;
  fromStatus: SagaStatus | null;
  toStatus: SagaStatus | null;
  payload: Record<string, unknown>;
}

class SagaEventModel extends Model<SagaEventAttributes, Optional<SagaEventAttributes, "id">>
  implements SagaEventAttributes {
  declare id: number;
  declare sagaId: string;
  declare correlationId: string | null;
  declare eventType: string;
  declare fromStatus: SagaStatus | null;
  declare toStatus: SagaStatus | null;
  declare payload: Record<string, unknown>;
  declare readonly createdAt: Date;
}

SagaEventModel.init(
  {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    sagaId: { type: DataTypes.STRING(128), allowNull: false, field: "saga_id" },
    correlationId: { type: DataTypes.STRING(128), allowNull: true, field: "correlation_id" },
    eventType: { type: DataTypes.STRING(64), allowNull: false, field: "event_type" },
    fromStatus: { type: DataTypes.STRING(32), allowNull: true, field: "from_status" },
    toStatus: { type: DataTypes.STRING(32), allowNull: true, field: "to_status" },
    payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  },
  {
    sequelize,
    modelName: "SagaEvent",
    tableName: "saga_events",
    timestamps: true,
    updatedAt: false,
  }
);

function toRecord(row: SagaExecutionModel): SagaRecord {
  return {
    sagaId: row.sagaId,
    orderId: row.orderId,
    workflowType: row.workflowType,
    status: row.status,
    currentStep: row.currentStep,
    completedSteps: row.completedSteps.map((step) => ({ ...step, output: { ...step.output } })),
    context: row.context,
    version: row.version,
    correlationId: row.correlationId ?? "",
    error: row.error,
    expiresAt: row.expiresAt,
    claimExpiresAt: row.claimExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEvent(row: SagaEventModel): SagaEvent {
  return {
    sagaId: row.sagaId,
    correlationId: row.correlationId ?? "",
    eventType: row.eventType,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    payload: row.payload,
    createdAt: row.createdAt,
  };
}

export async function connectSagaDb(): Promise<void> {
  try {
    await sequelize.authenticate();
    log.info("Saga store database connection established");
  } catch (err) {
    log.error("Unable to connect to saga store database", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Durable SagaStore backed by PostgreSQL — required so compensation can resume after a crash. */
export class PostgresSagaStore implements SagaStore {
  async create(record: SagaRecord): Promise<SagaRecord> {
    validateSagaContext(record.context);
    const [row] = await SagaExecutionModel.findOrCreate({
      where: { sagaId: record.sagaId },
      defaults: {
        sagaId: record.sagaId,
        orderId: record.orderId,
        workflowType: record.workflowType,
        status: record.status,
        currentStep: record.currentStep,
        completedSteps: record.completedSteps,
        context: record.context,
        correlationId: record.correlationId,
        error: record.error,
        version: 0,
        expiresAt: record.expiresAt,
        claimExpiresAt: null,
      },
    });
    return toRecord(row);
  }

  async createIfNotExists(record: SagaRecord): Promise<SagaRecord> {
    return this.create(record);
  }

  async get(sagaId: string): Promise<SagaRecord | null> {
    const row = await SagaExecutionModel.findByPk(sagaId);
    return row ? toRecord(row) : null;
  }

  /**
   * Conditional update keyed on `version` (optimistic locking) instead of a blind upsert, so
   * two runners racing on the same sagaId (e.g. startup recovery overlapping a manual resume())
   * can never both win the same step claim and execute it twice. Returns the row straight from
   * the guarded UPDATE (via `returning: true`) rather than re-reading it, since a re-read could
   * race with — and silently return — a newer version written by another runner.
   */
  async save(record: SagaRecord): Promise<SagaRecord> {
    validateSagaContext(record.context);
    const [affectedCount, updatedRows] = await SagaExecutionModel.update(
      {
        orderId: record.orderId,
        workflowType: record.workflowType,
        status: record.status,
        currentStep: record.currentStep,
        completedSteps: record.completedSteps,
        context: record.context,
        correlationId: record.correlationId,
        error: record.error,
        expiresAt: record.expiresAt,
        claimExpiresAt: record.claimExpiresAt,
        version: record.version + 1,
      },
      { where: { sagaId: record.sagaId, version: record.version }, returning: true }
    );
    if (affectedCount === 0 || !updatedRows[0]) {
      throw new SagaConcurrencyError(record.sagaId);
    }
    return toRecord(updatedRows[0]);
  }

  async listIncomplete(): Promise<SagaRecord[]> {
    const rows = await SagaExecutionModel.findAll({
      where: { status: { [Op.in]: ["running", "compensating"] } },
    });
    return rows.map(toRecord);
  }

  async listTimedOut(): Promise<SagaRecord[]> {
    const rows = await SagaExecutionModel.findAll({
      where: {
        status: { [Op.in]: ["running", "compensating"] },
        expiresAt: { [Op.lte]: new Date() },
      },
    });
    return rows.map(toRecord);
  }

  async appendEvent(event: SagaEvent): Promise<void> {
    await SagaEventModel.create({
      sagaId: event.sagaId,
      correlationId: event.correlationId,
      eventType: event.eventType,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      payload: event.payload,
    });
  }

  async getEvents(sagaId: string): Promise<SagaEvent[]> {
    const rows = await SagaEventModel.findAll({
      where: { sagaId },
      order: [["id", "ASC"]],
    });
    return rows.map(toEvent);
  }

  async findByCorrelationId(correlationId: string): Promise<SagaRecord | null> {
    const row = await SagaExecutionModel.findOne({ where: { correlationId } });
    return row ? toRecord(row) : null;
  }
}

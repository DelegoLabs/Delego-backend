/**
 * CDC configuration loading.
 *
 * The connector shape follows `CDCConfig` from @delegolabs/types. It can be
 * provided via a JSON file (`CDC_CONFIG_PATH`) or fully via environment
 * variables (`CDC_CONNECTOR`, `CDC_DB_*`, `CDC_TABLES`, `CDC_PUBLICATION`,
 * `CDC_SLOT`). The broker + metric endpoints come from the standard
 * `REDIS_URL`, `DATABASE_URL` and `CDC_PORT` settings.
 */

import type { CDCConfig, CDCConnectorKind } from "@delegolabs/types";

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";

export class CDCConfigError extends Error {}

export interface CdcRuntimeEnv {
  config?: CDCConfig;
  databaseUrl?: string;
  redisUrl?: string;
  port?: number;
  metricsIntervalMs?: number;
  publishTopicPrefix?: string;
}

function parseTables(raw: string): CDCConfig["tables"] {
  try {
    const parsed = JSON.parse(raw) as Array<{
      schema?: string;
      table?: string;
      pkColumns?: string[];
    }>;
    if (!Array.isArray(parsed)) throw new Error("expected an array");
    return parsed.map((t) => ({
      schema: t.schema ?? "public",
      table: String(t.table ?? ""),
      pkColumns: Array.isArray(t.pkColumns) ? t.pkColumns : [],
    }));
  } catch (err) {
    throw new CDCConfigError(
      `CDC_TABLES must be valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function loadConfigFile(path: string): CDCConfig {
  if (!existsSync(path)) {
    throw new CDCConfigError(`CDC config file not found at ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as CDCConfig;
  } catch (err) {
    throw new CDCConfigError(
      `CDC_CONFIG_PATH is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CDCConfig {
  const connector = (env.CDC_CONNECTOR ?? "logical_replication") as CDCConnectorKind;
  if (connector !== "debezium" && connector !== "logical_replication") {
    throw new CDCConfigError(`CDC_CONNECTOR must be 'debezium' or 'logical_replication'`);
  }

  if (!env.CDC_TABLES) {
    throw new CDCConfigError("CDC_TABLES is required when no CDC_CONFIG_PATH is given");
  }

  const config: CDCConfig = {
    connector,
    database: {
      host: env.CDC_DB_HOST ?? "localhost",
      port: Number(env.CDC_DB_PORT ?? 5432),
      name: env.CDC_DB_NAME ?? "delego",
      user: env.CDC_DB_USER ?? "delego",
      password: env.CDC_DB_PASSWORD ?? "delego",
    },
    tables: parseTables(env.CDC_TABLES),
    publication: env.CDC_PUBLICATION ?? "delego_cdc_publication",
    slotName: env.CDC_SLOT ?? "delego_cdc_slot",
  };

  if (config.tables.length === 0) {
    throw new CDCConfigError("CDC_TABLES must contain at least one table");
  }

  return config;
}

/**
 * Loads the effective runtime configuration. A `CDC_CONFIG_PATH` or the
 * environment-derived config takes precedence; `databaseUrl`/`redisUrl` allow
 * callers (and tests) to override the standard DATABASE_URL / REDIS_URL.
 */
export function loadCdcRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env
): CdcRuntimeEnv {
  const configPath = env.CDC_CONFIG_PATH;
  const config = configPath
    ? loadConfigFile(configPath)
    : loadConfigFromEnv(env);

  return {
    config,
    databaseUrl: env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego",
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    port: Number(env.CDC_PORT ?? 3017),
    metricsIntervalMs: Number(env.CDC_METRICS_INTERVAL_MS ?? 5000),
    publishTopicPrefix: env.CDC_TOPIC_PREFIX ?? "cdc",
  };
}

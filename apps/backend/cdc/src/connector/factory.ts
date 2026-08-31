/**
 * Connector factory — picks the concrete `CDCConnector` implementation for the
 * configured `CDCConfig.connector` kind.
 */

import type { CDCConfig } from "@delegolabs/types";
import type { Pool } from "pg";

import { DebeziumConnector, type DebeziumSource } from "./debezium.js";
import { LogicalReplicationConnector } from "./logicalReplication.js";
import type { CDCConnector } from "./types.js";

export interface CreateConnectorOptions {
  config: CDCConfig;
  /** Postgres pool used by the logical-replication connector for slot mgmt. */
  pool: Pool;
  /** Required when config.connector === "debezium". */
  debeziumSource?: DebeziumSource;
}

export function createConnector(options: CreateConnectorOptions): CDCConnector {
  switch (options.config.connector) {
    case "logical_replication":
      return new LogicalReplicationConnector({ config: options.config, pool: options.pool });
    case "debezium":
      if (!options.debeziumSource) {
        throw new Error("debeziumSource is required when connector === 'debezium'");
      }
      return new DebeziumConnector({ config: options.config, source: options.debeziumSource });
    default:
      throw new Error(`Unsupported CDC connector kind: ${options.config.connector}`);
  }
}

/**
 * @delegolabs/reconciliation — Entry point
 * Automated payment reconciliation system.
 */
import { createLogger } from "@delegolabs/utils";
import { startHttpServer } from "@delegolabs/utils";
import { connectDb } from "./db.js";
import { registerReconciliationRoutes } from "./routes/index.js";
import { sequelize } from "./db.js";
import { ReconciliationJob } from "./models/ReconciliationJob.js";
import { ReconciliationRecord } from "./models/ReconciliationRecord.js";
import { ReconciliationReport } from "./models/ReconciliationReport.js";
import { AuditLog } from "./models/AuditLog.js";
import { ExchangeRateCache } from "./models/ExchangeRateCache.js";
import { exchangeRateService } from "./services/exchangeRateService.js";
import { reconciliationJobService } from "./services/reconciliationJobService.js";
import { matcherService } from "./services/matcherService.js";
import { resolverService } from "./services/resolverService.js";
import { reportingService } from "./services/reportingService.js";

const SERVICE_NAME = "reconciliation";
const DEFAULT_PORT = 3014;

const nodeEnv = process.env.NODE_ENV ?? "development";
const logLevel = process.env.LOG_LEVEL ?? "info";
const log = createLogger(SERVICE_NAME, logLevel);
const port = Number(process.env.RECONCILIATION_SERVICE_PORT ?? DEFAULT_PORT);

// Register models
ReconciliationJob;
ReconciliationRecord;
ReconciliationReport;
AuditLog;
ExchangeRateCache;

log.info("Starting reconciliation service", { port, nodeEnv });

// Connect to database before starting server
connectDb()
  .then(() => {
    log.info("Database connected, starting server");
    startHttpServer({
      port,
      serviceName: SERVICE_NAME,
      routes: registerReconciliationRoutes(),
    });
  })
  .catch((err) => {
    log.error("Failed to connect to database", err instanceof Error ? { error: err.message } : { error: String(err) });
    process.exit(1);
  });

// Graceful shutdown
process.on("SIGTERM", async () => {
  log.info("Received SIGTERM, shutting down gracefully");
  await sequelize.close();
  process.exit(0);
});

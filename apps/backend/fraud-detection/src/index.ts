/**
 * @delegolabs/fraud-detection — Entry point
 * Fraud detection service with ML scoring and rule engine.
 */
import { createLogger } from "@delegolabs/utils";
import { startHttpServer } from "@delegolabs/utils";
import { connectDb } from "./db.js";
import { registerFraudRoutes } from "./routes/index.js";
import { sequelize } from "./db.js";
import { FraudRule } from "./models/FraudRule.js";
import { FraudCase } from "./models/FraudCase.js";
import { FraudCheckResult } from "./models/FraudCheckResult.js";
import { DeviceFingerprint } from "./models/DeviceFingerprint.js";
import { FraudEventLog } from "./models/FraudEventLog.js";
import { mlScorer } from "./mlScorer.js";
import { ruleEngine } from "./ruleEngine.js";

const SERVICE_NAME = "fraud-detection";
const DEFAULT_PORT = 3013;

const nodeEnv = process.env.NODE_ENV ?? "development";
const logLevel = process.env.LOG_LEVEL ?? "info";
const log = createLogger(SERVICE_NAME, logLevel);
const port = Number(process.env.FRAUD_SERVICE_PORT ?? DEFAULT_PORT);

// Register models
FraudRule;
FraudCase;
FraudCheckResult;
DeviceFingerprint;
FraudEventLog;

// Initialize ML scorer
mlScorer.loadModel();

// Load rules
ruleEngine.loadRules();

log.info("Starting fraud detection service", { port, nodeEnv });

// Connect to database before starting server
connectDb()
  .then(() => {
    log.info("Database connected, starting server");
    startHttpServer({
      port,
      serviceName: SERVICE_NAME,
      routes: registerFraudRoutes(),
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

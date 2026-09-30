/**
 * @delegolabs/gateway — API entry point
 * Routes external requests to internal services.
 */
import { createLogger, initTelemetry, startHttpServer, corsMiddleware, securityHeadersMiddleware } from "@delegolabs/utils";
import { registerRoutes } from "../routes/index.js";
import { bodyLimitMiddleware } from "../routes/api-v1.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { requestIdMiddleware } from "../middleware/requestId.js";
import { correlationMiddleware } from "../middleware/correlation.js";
import { compressionMiddleware } from "../middleware/compression.js";
import { openApiValidationMiddleware } from "../middleware/openApiValidation.js";
import { requestResponseLoggingMiddleware } from "./logging/middleware.js";
import { raspMiddleware } from "../middleware/rasp.js";
import { versionNegotiationMiddleware } from "./middleware/versioning.js";
import { metricsMiddleware } from "./metrics.js";
import { killSwitchMiddleware } from "../middleware/killSwitch.js";
import { getEmergencyKillSwitchService } from "./emergency/killSwitch.js";
import { registerGracefulShutdown } from "./shutdown.js";
import { startMetricsSampling, adaptiveRateLimitingMiddleware } from "./rateLimit/adaptive.js";

const SERVICE_NAME = "gateway";
const DEFAULT_PORT = 3000;

const nodeEnv = process.env.NODE_ENV ?? "development";
const logLevel = process.env.LOG_LEVEL ?? "info";
const log = createLogger(SERVICE_NAME, logLevel);

// Distributed tracing (Issue #307): enabled when OTEL_EXPORTER_OTLP_ENDPOINT is set.
void initTelemetry(SERVICE_NAME).catch((err: unknown) =>
  log.warn("Telemetry init failed", { error: err instanceof Error ? err.message : String(err) })
);
const port = Number(process.env.GATEWAY_PORT ?? DEFAULT_PORT);

logger.info("Starting gateway", { port, nodeEnv, logLevel });

// Start emergency kill-switch subscriber
getEmergencyKillSwitchService().start().catch((err) => {
  log.warn("Failed to initialize emergency kill-switch service", { error: err.message });
});

startMetricsSampling();

const server = startHttpServer({
  port,
  serviceName: SERVICE_NAME,
  middleware: [
    metricsMiddleware(),
    correlationMiddleware,
    requestIdMiddleware(),
    corsMiddleware(),
    securityHeadersMiddleware(),
    killSwitchMiddleware(),
    raspMiddleware(),
    // Version negotiation must run before auth and rate-limiting so that
    // sunset versions get 410 Gone before any further processing.
    versionNegotiationMiddleware(),
    bodyLimitMiddleware(),
    // OpenAPI request validation - validates path, query, and body parameters
    validateRequest(),
    openApiValidationMiddleware({
      validateResponses: process.env.GATEWAY_VALIDATE_RESPONSES === "true",
    }),
    adaptiveRateLimitingMiddleware(),
    rateLimitMiddleware(),
    compressionMiddleware(),
    requestResponseLoggingMiddleware(),
  ],
  routes: registerRoutes(),
});

registerGracefulShutdown(server);

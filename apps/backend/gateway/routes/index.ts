import type { Route } from "@delegolabs/utils";
import { route } from "@delegolabs/utils";
import { healthHandler } from "./health.js";
import { apiV1Handler } from "./api-v1.js";
import {
  registerHandler,
  loginHandler,
  refreshHandler,
  logoutHandler,
  oauthCallbackHandler,
  oauthAuthorizeHandler,
} from "./auth.js";
import {
  createDelegationHandler,
  listDelegationsHandler,
  getDelegationHandler,
  updateDelegationHandler,
  revokeDelegationHandler,
} from "./delegations.js";
import { getWalletHandler } from "./wallets.js";
import { rateLimitMetricsHandler, tieredRateLimitMetricsHandler, circuitBreakerStatusHandler } from "./admin.js";
import { swaggerHandler } from "../src/swagger.js";

/** Register all gateway routes */
export function registerRoutes(): Route[] {
  return [
    route("GET", "/health", healthHandler),
    route("GET", "/api/v1/status", apiV1Handler),
    route("POST", "/api/v1/auth/register", registerHandler),
    route("POST", "/api/v1/auth/login", loginHandler),
    route("POST", "/api/v1/auth/refresh", refreshHandler),
    route("POST", "/api/v1/auth/logout", logoutHandler),
    route("GET", "/api/v1/auth/oauth/authorize", oauthAuthorizeHandler),
    route("POST", "/api/v1/auth/oauth/callback", oauthCallbackHandler),
    route("POST", "/api/v1/delegations", createDelegationHandler),
    route("GET", "/api/v1/delegations", listDelegationsHandler),
    route("GET", "/api/v1/delegations/:id", getDelegationHandler),
    route("PATCH", "/api/v1/delegations/:id", updateDelegationHandler),
    route("DELETE", "/api/v1/delegations/:id", revokeDelegationHandler),
    route("GET", "/api/v1/wallets/:walletId", getWalletHandler),
    // Admin — rate-limit dashboard (#340)
    route("GET", "/api/v1/admin/rate-limit/metrics", rateLimitMetricsHandler),
    // Admin — tiered token-bucket rate-limit metrics (#51)
    route("GET", "/api/v1/admin/rate-limit/tiered-metrics", tieredRateLimitMetricsHandler),
    // Admin — circuit breaker status (#364)
    route("GET", "/api/v1/admin/circuit-breakers", circuitBreakerStatusHandler),
    // Swagger UI (#352)
    route("GET", "/api/docs", swaggerHandler),
    route("GET", "/api/docs/openapi.json", swaggerHandler),
  ];
}

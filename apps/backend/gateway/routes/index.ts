import type { Route } from "@delegolabs/utils";
import { route } from "@delegolabs/utils";
import { registerHealthRoutes } from "./health.js";
import { apiV1Handler } from "./api-v1.js";
import {
  registerHandler,
  loginHandler,
  refreshHandler,
  logoutHandler,
  oauthCallbackHandler,
  oauthAuthorizeHandler,
  introspectHandler,
  revokeHandler,
  jwksHandler,
} from "./auth.js";
import {
  createDelegationHandler,
  listDelegationsHandler,
  getDelegationHandler,
  updateDelegationHandler,
  revokeDelegationHandler,
} from "./delegations.js";
import { getWalletHandler } from "./wallets.js";
import { rateLimitMetricsHandler, circuitBreakerStatusHandler } from "./admin.js";
import { auditLogQueryHandler, auditLogVerifyHandler } from "./audit.js";
import { swaggerHandler } from "../src/swagger.js";
import { logSearchHandler, logStatsHandler, logClearHandler } from "../src/logging/routes.js";
import {
  createApiKeyHandler,
  listApiKeysHandler,
  getApiKeyHandler,
  revokeApiKeyHandler,
  suspendApiKeyHandler,
  activateApiKeyHandler,
  updateApiKeyScopesHandler,
} from "../src/apiKeyScoping/routes.js";
import {
  registerScriptHandler,
  listScriptsHandler,
  getScriptHandler,
  testScriptHandler,
  deployScriptHandler,
  rollbackScriptHandler,
  getScriptMetricsHandler,
  deleteScriptHandler,
} from "../lua-scripts/src/routes.js";
import {
  createScheduleHandler,
  listSchedulesHandler,
  getScheduleHandler,
  updateScheduleHandler,
  deleteScheduleHandler,
  getCurrentOnCallHandler,
  createPolicyHandler,
  listPoliciesHandler,
  getPolicyHandler,
  createRouteHandler,
  listRoutesHandler,
  createAlertHandler,
  listAlertsHandler,
  acknowledgeAlertHandler,
  resolveAlertHandler,
  createChannelHandler,
  listChannelsHandler,
  sendNotificationHandler,
  monitoringDashboardHandler,
} from "../monitoring/src/routes.js";

/** Register all gateway routes */
export function registerRoutes(): Route[] {
  return [
    ...registerHealthRoutes(),
    route("GET", "/api/v1/status", apiV1Handler),
    route("POST", "/api/v1/auth/register", registerHandler),
    route("POST", "/api/v1/auth/login", loginHandler),
    route("POST", "/api/v1/auth/refresh", refreshHandler),
    route("POST", "/api/v1/auth/logout", logoutHandler),
    // JWT management (Issue #77)
    route("POST", "/api/v1/auth/introspect", introspectHandler),
    route("POST", "/api/v1/auth/revoke", revokeHandler),
    route("GET", "/api/v1/auth/.well-known/jwks.json", jwksHandler),
    route("GET", "/.well-known/jwks.json", jwksHandler),
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
    // Admin — circuit breaker status (#364)
    route("GET", "/api/v1/admin/circuit-breakers", circuitBreakerStatusHandler),
    // Request/response logging (#151)
    route("GET", "/api/v1/admin/logs", logSearchHandler),
    route("GET", "/api/v1/admin/logs/stats", logStatsHandler),
    route("DELETE", "/api/v1/admin/logs", logClearHandler),
    // API key scoping (#152)
    route("POST", "/api/v1/api-keys", createApiKeyHandler),
    route("GET", "/api/v1/api-keys", listApiKeysHandler),
    route("GET", "/api/v1/api-keys/:id", getApiKeyHandler),
    route("PATCH", "/api/v1/api-keys/:id/scopes", updateApiKeyScopesHandler),
    route("POST", "/api/v1/api-keys/:id/revoke", revokeApiKeyHandler),
    route("POST", "/api/v1/api-keys/:id/suspend", suspendApiKeyHandler),
    route("POST", "/api/v1/api-keys/:id/activate", activateApiKeyHandler),
    // Lua script management (#156)
    route("POST", "/api/v1/lua-scripts", registerScriptHandler),
    route("GET", "/api/v1/lua-scripts", listScriptsHandler),
    route("GET", "/api/v1/lua-scripts/:name", getScriptHandler),
    route("POST", "/api/v1/lua-scripts/:name/test", testScriptHandler),
    route("POST", "/api/v1/lua-scripts/:name/deploy", deployScriptHandler),
    route("POST", "/api/v1/lua-scripts/:name/rollback", rollbackScriptHandler),
    route("GET", "/api/v1/lua-scripts/:name/metrics", getScriptMetricsHandler),
    route("DELETE", "/api/v1/lua-scripts/:name", deleteScriptHandler),
    // Monitoring - Alert routing & on-call (#157)
    route("POST", "/api/v1/monitoring/schedules", createScheduleHandler),
    route("GET", "/api/v1/monitoring/schedules", listSchedulesHandler),
    route("GET", "/api/v1/monitoring/schedules/:id", getScheduleHandler),
    route("PATCH", "/api/v1/monitoring/schedules/:id", updateScheduleHandler),
    route("DELETE", "/api/v1/monitoring/schedules/:id", deleteScheduleHandler),
    route("GET", "/api/v1/monitoring/schedules/:id/oncall", getCurrentOnCallHandler),
    route("POST", "/api/v1/monitoring/policies", createPolicyHandler),
    route("GET", "/api/v1/monitoring/policies", listPoliciesHandler),
    route("GET", "/api/v1/monitoring/policies/:id", getPolicyHandler),
    route("POST", "/api/v1/monitoring/routes", createRouteHandler),
    route("GET", "/api/v1/monitoring/routes", listRoutesHandler),
    route("POST", "/api/v1/monitoring/alerts", createAlertHandler),
    route("GET", "/api/v1/monitoring/alerts", listAlertsHandler),
    route("POST", "/api/v1/monitoring/alerts/:id/acknowledge", acknowledgeAlertHandler),
    route("POST", "/api/v1/monitoring/alerts/:id/resolve", resolveAlertHandler),
    route("POST", "/api/v1/monitoring/channels", createChannelHandler),
    route("GET", "/api/v1/monitoring/channels", listChannelsHandler),
    route("POST", "/api/v1/monitoring/notifications/send", sendNotificationHandler),
    route("GET", "/api/v1/monitoring/dashboard", monitoringDashboardHandler),
    // Admin — audit log query API (#66)
    route("GET", "/api/v1/admin/audit-log", auditLogQueryHandler),
    route("GET", "/api/v1/admin/audit-log/verify", auditLogVerifyHandler),
    // Swagger UI (#352)
    route("GET", "/api/docs", swaggerHandler),
    route("GET", "/api/docs/openapi.json", swaggerHandler),
  ];
}

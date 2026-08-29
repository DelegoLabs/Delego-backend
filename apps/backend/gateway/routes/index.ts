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
function withVersionAlias(method: string, path: string, handler: Parameters<typeof route>[2]): Route[] {
  return ["v1", "v2"].map((version) => route(method, path.replace("/api/v1", `/api/${version}`), handler));
}

export function registerRoutes(): Route[] {
  return [
    ...registerHealthRoutes(),
    ...withVersionAlias("GET", "/api/v1/status", apiV1Handler),
    ...withVersionAlias("POST", "/api/v1/auth/register", registerHandler),
    ...withVersionAlias("POST", "/api/v1/auth/login", loginHandler),
    ...withVersionAlias("POST", "/api/v1/auth/refresh", refreshHandler),
    ...withVersionAlias("POST", "/api/v1/auth/logout", logoutHandler),
    // JWT management (Issue #77)
    ...withVersionAlias("POST", "/api/v1/auth/introspect", introspectHandler),
    ...withVersionAlias("POST", "/api/v1/auth/revoke", revokeHandler),
    ...withVersionAlias("GET", "/api/v1/auth/.well-known/jwks.json", jwksHandler),
    ...withVersionAlias("GET", "/api/v1/auth/oauth/authorize", oauthAuthorizeHandler),
    ...withVersionAlias("POST", "/api/v1/auth/oauth/callback", oauthCallbackHandler),
    ...withVersionAlias("POST", "/api/v1/delegations", createDelegationHandler),
    ...withVersionAlias("GET", "/api/v1/delegations", listDelegationsHandler),
    ...withVersionAlias("GET", "/api/v1/delegations/:id", getDelegationHandler),
    ...withVersionAlias("PATCH", "/api/v1/delegations/:id", updateDelegationHandler),
    ...withVersionAlias("DELETE", "/api/v1/delegations/:id", revokeDelegationHandler),
    ...withVersionAlias("GET", "/api/v1/wallets/:walletId", getWalletHandler),
    // Admin — rate-limit dashboard (#340)
    ...withVersionAlias("GET", "/api/v1/admin/rate-limit/metrics", rateLimitMetricsHandler),
    // Admin — circuit breaker status (#364)
    ...withVersionAlias("GET", "/api/v1/admin/circuit-breakers", circuitBreakerStatusHandler),
    // Request/response logging (#151)
    ...withVersionAlias("GET", "/api/v1/admin/logs", logSearchHandler),
    ...withVersionAlias("GET", "/api/v1/admin/logs/stats", logStatsHandler),
    ...withVersionAlias("DELETE", "/api/v1/admin/logs", logClearHandler),
    // API key scoping (#152)
    ...withVersionAlias("POST", "/api/v1/api-keys", createApiKeyHandler),
    ...withVersionAlias("GET", "/api/v1/api-keys", listApiKeysHandler),
    ...withVersionAlias("GET", "/api/v1/api-keys/:id", getApiKeyHandler),
    ...withVersionAlias("PATCH", "/api/v1/api-keys/:id/scopes", updateApiKeyScopesHandler),
    ...withVersionAlias("POST", "/api/v1/api-keys/:id/revoke", revokeApiKeyHandler),
    ...withVersionAlias("POST", "/api/v1/api-keys/:id/suspend", suspendApiKeyHandler),
    ...withVersionAlias("POST", "/api/v1/api-keys/:id/activate", activateApiKeyHandler),
    // Lua script management (#156)
    ...withVersionAlias("POST", "/api/v1/lua-scripts", registerScriptHandler),
    ...withVersionAlias("GET", "/api/v1/lua-scripts", listScriptsHandler),
    ...withVersionAlias("GET", "/api/v1/lua-scripts/:name", getScriptHandler),
    ...withVersionAlias("POST", "/api/v1/lua-scripts/:name/test", testScriptHandler),
    ...withVersionAlias("POST", "/api/v1/lua-scripts/:name/deploy", deployScriptHandler),
    ...withVersionAlias("POST", "/api/v1/lua-scripts/:name/rollback", rollbackScriptHandler),
    ...withVersionAlias("GET", "/api/v1/lua-scripts/:name/metrics", getScriptMetricsHandler),
    ...withVersionAlias("DELETE", "/api/v1/lua-scripts/:name", deleteScriptHandler),
    // Monitoring - Alert routing & on-call (#157)
    ...withVersionAlias("POST", "/api/v1/monitoring/schedules", createScheduleHandler),
    ...withVersionAlias("GET", "/api/v1/monitoring/schedules", listSchedulesHandler),
    ...withVersionAlias("GET", "/api/v1/monitoring/schedules/:id", getScheduleHandler),
    ...withVersionAlias("PATCH", "/api/v1/monitoring/schedules/:id", updateScheduleHandler),
    ...withVersionAlias("DELETE", "/api/v1/monitoring/schedules/:id", deleteScheduleHandler),
    ...withVersionAlias("GET", "/api/v1/monitoring/schedules/:id/oncall", getCurrentOnCallHandler),
    ...withVersionAlias("POST", "/api/v1/monitoring/policies", createPolicyHandler),
    ...withVersionAlias("GET", "/api/v1/monitoring/policies", listPoliciesHandler),
    ...withVersionAlias("GET", "/api/v1/monitoring/policies/:id", getPolicyHandler),
    ...withVersionAlias("POST", "/api/v1/monitoring/routes", createRouteHandler),
    ...withVersionAlias("GET", "/api/v1/monitoring/routes", listRoutesHandler),
    ...withVersionAlias("POST", "/api/v1/monitoring/alerts", createAlertHandler),
    ...withVersionAlias("GET", "/api/v1/monitoring/alerts", listAlertsHandler),
    ...withVersionAlias("POST", "/api/v1/monitoring/alerts/:id/acknowledge", acknowledgeAlertHandler),
    ...withVersionAlias("POST", "/api/v1/monitoring/alerts/:id/resolve", resolveAlertHandler),
    ...withVersionAlias("POST", "/api/v1/monitoring/channels", createChannelHandler),
    ...withVersionAlias("GET", "/api/v1/monitoring/channels", listChannelsHandler),
    ...withVersionAlias("POST", "/api/v1/monitoring/notifications/send", sendNotificationHandler),
    ...withVersionAlias("GET", "/api/v1/monitoring/dashboard", monitoringDashboardHandler),
    // Swagger UI (#352)
    route("GET", "/api/docs", swaggerHandler),
    route("GET", "/api/docs/openapi.json", swaggerHandler),
    route("GET", "/.well-known/jwks.json", jwksHandler),
  ];
}

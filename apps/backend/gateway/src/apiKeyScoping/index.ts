/**
 * API Key Scoping module exports
 * Issue #152
 */

export { checkScope, mergeScopes, generateApiKeyPrefix } from "./scopeChecker.js";
export {
  createApiKey,
  getApiKey,
  listApiKeys,
  revokeApiKey,
  suspendApiKey,
  activateApiKey,
  updateApiKeyScopes,
  incrementQuotaUsage,
  findApiKeyByPrefix,
  type ApiKeyCreateResult,
} from "./service.js";
export { apiKeyScopeMiddleware, getApiKeyContext } from "./middleware.js";
export {
  createApiKeyHandler,
  listApiKeysHandler,
  getApiKeyHandler,
  revokeApiKeyHandler,
  suspendApiKeyHandler,
  activateApiKeyHandler,
  updateApiKeyScopesHandler,
} from "./routes.js";

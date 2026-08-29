import type { IncomingMessage, ServerResponse } from "node:http";
import { generateId, json } from "@delegolabs/utils";
import * as authService from "../src/auth/authService.js";
import * as oauthService from "../src/auth/oauthService.js";
import {
  publishAuthAuditEvent,
  AUTH_AUDIT_ACTIONS,
} from "../src/auth/authAuditEvent.js";
import type { TokenBinding } from "../src/auth/tokenTypes.js";
import {
  validateSchema,
  RegisterSchema,
  LoginSchema,
  OAuthCallbackSchema,
} from "../src/validation.js";
import {
  readJsonBody,
  InvalidJsonError,
  BodyTooLargeError,
} from "../src/request.js";
import { badRequest, sendApiError, unauthorized } from "../src/errors.js";
import { getRequestContext } from "../middleware/requestId.js";
import {
  extractAuth,
  getAuthenticatedUserContext,
} from "../middleware/auth.js";

export const authDependencies = {
  registerUser: authService.registerUser,
  loginUser: authService.loginUser,
  refreshAccessToken: authService.refreshAccessToken,
  logoutUser: authService.logoutUser,
  introspectToken: authService.introspectToken,
  revokeTokens: authService.revokeTokens,
  getJwks: authService.getJwks,
  handleOAuthCallback: oauthService.handleOAuthCallback,
  buildAuthorizationUrl: oauthService.buildAuthorizationUrl,
  validateProvider: oauthService.validateProvider,
};

function resolveRequestId(req: IncomingMessage): string {
  return getRequestContext(req)?.requestId ?? generateId();
}

/** Extract optional token-binding claims from device headers. */
function getTokenBinding(req: IncomingMessage): TokenBinding | undefined {
  const headers = req.headers;
  const deviceId = Array.isArray(headers["x-device-id"])
    ? headers["x-device-id"][0]
    : headers["x-device-id"];
  const fingerprint = Array.isArray(headers["x-device-fingerprint"])
    ? headers["x-device-fingerprint"][0]
    : headers["x-device-fingerprint"];
  if (!deviceId && !fingerprint) return undefined;
  return {
    deviceId: deviceId ?? fingerprint ?? "",
    ...(fingerprint ? { fingerprint } : {}),
  };
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const list: Record<string, string> = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(";").forEach((cookie) => {
      const parts = cookie.split("=");
      if (parts.length >= 2) {
        const key = parts.shift()?.trim() ?? "";
        const value = decodeURIComponent(parts.join("=").trim());
        if (key) {
          list[key] = value;
        }
      }
    });
  }
  return list;
}

function setRefreshTokenCookie(
  res: ServerResponse,
  refreshToken: string,
): void {
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const cookie = [
    `refresh_token=${refreshToken}`,
    `Expires=${expires.toUTCString()}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
  ].join("; ");
  res.setHeader("Set-Cookie", cookie);
}

function clearRefreshTokenCookie(res: ServerResponse): void {
  const cookie = [
    "refresh_token=",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
  ].join("; ");
  res.setHeader("Set-Cookie", cookie);
}

export async function registerHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestId = resolveRequestId(req);
  let email: string | undefined;

  try {
    const body = await readJsonBody(req);
    email = typeof body.email === "string" ? body.email : undefined;
    const validation = validateSchema(RegisterSchema, body);
    if (!validation.valid) {
      publishAuthAuditEvent({
        action: AUTH_AUDIT_ACTIONS.REGISTER,
        success: false,
        requestId,
        email,
      });
      badRequest(res, "Invalid request body", req, validation.errors);
      return;
    }

    const result = await authDependencies.registerUser(
      body.email,
      body.password,
      body.displayName,
      getTokenBinding(req),
    );
    publishAuthAuditEvent({
      action: AUTH_AUDIT_ACTIONS.REGISTER,
      success: true,
      requestId,
      userId: result.user.id,
      email: result.user.email,
    });
    setRefreshTokenCookie(res, result.refreshToken);
    json(res, 201, {
      data: {
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
        refreshExpiresIn: result.refreshExpiresIn,
        tokenType: result.tokenType,
        scope: result.scope,
      },
      error: null,
    });
  } catch (err: any) {
    publishAuthAuditEvent({
      action: AUTH_AUDIT_ACTIONS.REGISTER,
      success: false,
      requestId,
      email,
    });
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
    } else {
      sendApiError(res, 400, "BAD_REQUEST", err.message, req);
    }
  }
}

export async function loginHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestId = resolveRequestId(req);
  let email: string | undefined;

  try {
    const body = await readJsonBody(req);
    email = typeof body.email === "string" ? body.email : undefined;
    const validation = validateSchema(LoginSchema, body);
    if (!validation.valid) {
      publishAuthAuditEvent({
        action: AUTH_AUDIT_ACTIONS.LOGIN,
        success: false,
        requestId,
        email,
      });
      badRequest(res, "Invalid request body", req, validation.errors);
      return;
    }

    const result = await authDependencies.loginUser(
      body.email,
      body.password,
      getTokenBinding(req),
    );
    publishAuthAuditEvent({
      action: AUTH_AUDIT_ACTIONS.LOGIN,
      success: true,
      requestId,
      userId: result.user.id,
      email: result.user.email,
    });
    setRefreshTokenCookie(res, result.refreshToken);
    json(res, 200, {
      data: {
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
        refreshExpiresIn: result.refreshExpiresIn,
        tokenType: result.tokenType,
        scope: result.scope,
      },
      error: null,
    });
  } catch (err: any) {
    publishAuthAuditEvent({
      action: AUTH_AUDIT_ACTIONS.LOGIN,
      success: false,
      requestId,
      email,
    });
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
    } else {
      unauthorized(res, err.message, req);
    }
  }
}

export async function refreshHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestId = resolveRequestId(req);

  try {
    const cookies = parseCookies(req);
    const refreshToken = cookies.refresh_token;

    if (!refreshToken) {
      publishAuthAuditEvent({
        action: AUTH_AUDIT_ACTIONS.REFRESH,
        success: false,
        requestId,
      });
      unauthorized(res, "Refresh token missing", req);
      return;
    }

    const result = await authDependencies.refreshAccessToken(
      refreshToken,
      getTokenBinding(req),
    );
    publishAuthAuditEvent({
      action: AUTH_AUDIT_ACTIONS.REFRESH,
      success: true,
      requestId,
      userId: getAuthenticatedUserContext(req)?.userId,
      email: getAuthenticatedUserContext(req)?.email,
    });
    setRefreshTokenCookie(res, result.refreshToken);
    json(res, 200, {
      data: {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
        refreshExpiresIn: result.refreshExpiresIn,
        tokenType: result.tokenType,
        scope: result.scope,
      },
      error: null,
    });
  } catch (err: any) {
    publishAuthAuditEvent({
      action: AUTH_AUDIT_ACTIONS.REFRESH,
      success: false,
      requestId,
    });
    unauthorized(res, err.message, req);
  }
}

export async function logoutHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestId = resolveRequestId(req);
  const auth = extractAuth(req);

  if (!auth.userId) {
    publishAuthAuditEvent({
      action: AUTH_AUDIT_ACTIONS.LOGOUT,
      success: false,
      requestId,
    });
    unauthorized(res, "Authentication required", req);
    return;
  }

  const cookies = parseCookies(req);
  await authDependencies.logoutUser(cookies.refresh_token);
  clearRefreshTokenCookie(res);

  publishAuthAuditEvent({
    action: AUTH_AUDIT_ACTIONS.LOGOUT,
    success: true,
    requestId,
    userId: auth.userId,
    email: getAuthenticatedUserContext(req)?.email,
  });

  json(res, 200, {
    data: { success: true },
    error: null,
  });
}

export async function oauthCallbackHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestId = resolveRequestId(req);

  try {
    const body = await readJsonBody(req);
    const validation = validateSchema(OAuthCallbackSchema, body);
    if (!validation.valid) {
      publishAuthAuditEvent({
        action: AUTH_AUDIT_ACTIONS.OAUTH_LOGIN,
        success: false,
        requestId,
      });
      badRequest(res, "Invalid request body", req, validation.errors);
      return;
    }

    const { provider, code } = body;
    const redirectUri = process.env.OAUTH_REDIRECT_URI ?? "";

    const result = await authDependencies.handleOAuthCallback(provider, code, redirectUri);

    publishAuthAuditEvent({
      action: result.isNewUser ? AUTH_AUDIT_ACTIONS.OAUTH_REGISTER : AUTH_AUDIT_ACTIONS.OAUTH_LOGIN,
      success: true,
      requestId,
      userId: result.user.id,
      email: result.user.email,
    });

    setRefreshTokenCookie(res, result.refreshToken);
    json(res, 200, {
      data: {
        user: result.user,
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
        isNewUser: result.isNewUser,
      },
      error: null,
    });
  } catch (err: any) {
    publishAuthAuditEvent({
      action: AUTH_AUDIT_ACTIONS.OAUTH_LOGIN,
      success: false,
      requestId,
    });
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
    } else {
      sendApiError(res, 400, "OAUTH_ERROR", err.message, req);
    }
  }
}

export async function oauthAuthorizeHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const provider = url.searchParams.get("provider");
  const redirectUri = url.searchParams.get("redirect_uri") ?? process.env.OAUTH_REDIRECT_URI ?? "";

  if (!provider) {
    sendApiError(res, 400, "VALIDATION_ERROR", "provider query parameter is required", req);
    return;
  }

  try {
    const validatedProvider = authDependencies.validateProvider(provider);
    const state = generateId();
    const authorizationUrl = authDependencies.buildAuthorizationUrl(validatedProvider, redirectUri, state);

    json(res, 200, {
      data: { authorizationUrl, state },
      error: null,
    });
  } catch (err: any) {
    sendApiError(res, 400, "INVALID_PROVIDER", err.message, req);
  }
}

/**
 * POST /api/v1/auth/introspect — RFC 7662-style token introspection.
 * Body: { token: string } — returns whether the token is active, plus claims.
 */
export async function introspectHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestId = resolveRequestId(req);

  try {
    const body = await readJsonBody(req);
    const token = typeof body.token === "string" ? body.token : undefined;

    if (!token) {
      badRequest(res, "token is required", req);
      return;
    }

    const result = await authDependencies.introspectToken(token);
    publishAuthAuditEvent({
      action: AUTH_AUDIT_ACTIONS.LOGIN,
      success: result.active,
      requestId,
      userId: result.userId,
      email: result.email,
    });
    json(res, 200, { data: result, error: null });
  } catch (err: any) {
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
    } else {
      sendApiError(res, 400, "INTROSPECTION_ERROR", err.message, req);
    }
  }
}

/**
 * POST /api/v1/auth/revoke — revoke an access and/or refresh token.
 * Body: { token?, refreshToken?, reason? } — blacklists the token(s) and
 * revokes the refresh-token family.
 */
export async function revokeHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestId = resolveRequestId(req);

  try {
    const body = await readJsonBody(req);
    const token = typeof body.token === "string" ? body.token : undefined;
    const refreshToken = typeof body.refreshToken === "string" ? body.refreshToken : undefined;
    const reason =
      body.reason === "logout" ||
      body.reason === "password_change" ||
      body.reason === "security" ||
      body.reason === "admin"
        ? body.reason
        : undefined;

    if (!token && !refreshToken) {
      badRequest(res, "token or refreshToken is required", req);
      return;
    }

    const auth = extractAuth(req);
    const result = await authDependencies.revokeTokens({
      token,
      refreshToken,
      userId: auth.userId ?? undefined,
      reason,
    });

    publishAuthAuditEvent({
      action: AUTH_AUDIT_ACTIONS.LOGOUT,
      success: true,
      requestId,
      userId: auth.userId ?? undefined,
    });

    json(res, 200, {
      data: { success: true, ...result },
      error: null,
    });
  } catch (err: any) {
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
    } else {
      sendApiError(res, 400, "REVOCATION_ERROR", err.message, req);
    }
  }
}

/**
 * GET /api/v1/auth/.well-known/jwks.json — JWKS endpoint for key distribution.
 * Resource servers verify tokens against the published public keys.
 */
export function jwksHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  const keys = authDependencies.getJwks();
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=300",
  });
  res.end(JSON.stringify({ keys }));
}

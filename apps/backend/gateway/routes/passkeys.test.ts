import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

const mocks = vi.hoisted(() => ({
  getRequestContext: vi.fn(),
  getAuthenticatedUserContext: vi.fn(),
  beginPasskeyRegistration: vi.fn(),
  completePasskeyRegistration: vi.fn(),
  beginPasskeyAuthentication: vi.fn(),
  completePasskeyAuthentication: vi.fn(),
  listPasskeys: vi.fn(),
  renamePasskey: vi.fn(),
  deletePasskey: vi.fn(),
  findUserByPk: vi.fn(),
  issueTokenPair: vi.fn(),
  readJsonBody: vi.fn(),
}));

vi.mock("../middleware/requestId.js", () => ({
  getRequestContext: mocks.getRequestContext,
}));

vi.mock("../middleware/auth.js", () => ({
  getAuthenticatedUserContext: mocks.getAuthenticatedUserContext,
}));

vi.mock("../src/auth/passkeyService.js", () => ({
  beginPasskeyRegistration: mocks.beginPasskeyRegistration,
  completePasskeyRegistration: mocks.completePasskeyRegistration,
  beginPasskeyAuthentication: mocks.beginPasskeyAuthentication,
  completePasskeyAuthentication: mocks.completePasskeyAuthentication,
  listPasskeys: mocks.listPasskeys,
  renamePasskey: mocks.renamePasskey,
  deletePasskey: mocks.deletePasskey,
}));

vi.mock("../src/auth/tokenManager.js", () => ({
  issueTokenPair: mocks.issueTokenPair,
}));

vi.mock("../src/models/User.js", () => ({
  User: { findByPk: mocks.findUserByPk },
}));

vi.mock("../src/request.js", () => ({
  readJsonBody: mocks.readJsonBody,
}));

import {
  beginRegistrationHandler,
  completeRegistrationHandler,
  beginAuthenticationHandler,
  completeAuthenticationHandler,
} from "./passkeys.js";
import { PasskeyError } from "../src/auth/passkeyTypes.js";

type MockResponse = ServerResponse & {
  statusCode: number;
  body: string;
  headersSent: boolean;
  headers: Record<string, string | string[] | number | undefined>;
};

const USER_ID = "user-123";
const USER_EMAIL = "user@example.com";
const USER_DISPLAY_NAME = "Delego User";
const REQUEST_ID = "req-passkeys-1";
const CHALLENGE = "Y2hhbGxlbmdl";
const CREDENTIAL_ID = "cred-abc";
const RP_ID = "passkeys.delego.io";

const REGISTRATION_OPTIONS = {
  challenge: CHALLENGE,
  rp: { name: "Delego", id: RP_ID },
};

const AUTHENTICATION_OPTIONS = {
  challenge: CHALLENGE,
  rpId: RP_ID,
};

const WEB_AUTHN_RESPONSE = {
  id: CREDENTIAL_ID,
  rawId: CREDENTIAL_ID,
  response: {
    clientDataJSON: "Y2xpZW50RGF0YUpTT04",
    attestationObject: "YXR0ZXN0YXRpb24",
  },
  clientExtensionResults: {},
  type: "public-key",
};

const CREDENTIAL = {
  id: CREDENTIAL_ID,
  name: "My Passkey",
  transports: ["internal"],
  deviceType: "multi-device",
  backedUp: true,
  userVerified: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: null,
};

const TOKENS = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresIn: 900,
  refreshExpiresIn: 86_400,
  tokenType: "Bearer",
  scope: "openid",
};

const AUTHENTICATED_USER = {
  userId: USER_ID,
  email: USER_EMAIL,
  roles: ["user"],
  permissions: [],
};

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.headers = { "x-request-id": REQUEST_ID, ...headers };
  req.url = "/api/v1/auth/passkeys/register/begin";
  return req;
}

function createRes(): MockResponse {
  return {
    statusCode: 0,
    body: "",
    headersSent: false,
    headers: {},
    setHeader(name: string, value: string | number) {
      this.headers[name] = value;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      this.headersSent = true;
      if (headers) Object.assign(this.headers, headers);
    },
    end(body?: string) {
      if (body !== undefined) this.body = body;
    },
  } as MockResponse;
}

function responseBody<T = Record<string, unknown>>(res: MockResponse): T {
  return JSON.parse(res.body) as T;
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.getRequestContext.mockImplementation((req: IncomingMessage) => {
    const forwarded = req.headers["x-request-id"];
    const requestId = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return requestId ? { requestId, startedAt: Date.now() } : undefined;
  });
  mocks.getAuthenticatedUserContext.mockReturnValue(AUTHENTICATED_USER);
  mocks.findUserByPk.mockResolvedValue({
    id: USER_ID,
    email: USER_EMAIL,
    displayName: USER_DISPLAY_NAME,
  });
  mocks.beginPasskeyRegistration.mockResolvedValue({
    options: REGISTRATION_OPTIONS,
    challenge: CHALLENGE,
  });
  mocks.completePasskeyRegistration.mockResolvedValue(CREDENTIAL);
  mocks.beginPasskeyAuthentication.mockResolvedValue({
    options: AUTHENTICATION_OPTIONS,
    challenge: CHALLENGE,
  });
  mocks.completePasskeyAuthentication.mockResolvedValue({
    userId: USER_ID,
    credential: { id: CREDENTIAL_ID, userId: USER_ID, publicKey: new Uint8Array([1]), counter: 7 },
    newCounter: 7,
    userVerified: true,
  });
  mocks.issueTokenPair.mockResolvedValue(TOKENS);
  mocks.readJsonBody.mockResolvedValue({ response: WEB_AUTHN_RESPONSE });
});

describe("passkey registration routes", () => {
  it("returns WebAuthn registration options for the authenticated user", async () => {
    const req = createReq();
    const res = createRes();

    await beginRegistrationHandler(req, res);

    expect(mocks.getAuthenticatedUserContext).toHaveBeenCalledWith(req);
    expect(mocks.findUserByPk).toHaveBeenCalledWith(USER_ID);
    expect(mocks.beginPasskeyRegistration).toHaveBeenCalledWith(
      USER_ID,
      USER_EMAIL,
      USER_DISPLAY_NAME
    );
    expect(res.statusCode).toBe(200);
    expect(responseBody(res)).toMatchObject({
      options: REGISTRATION_OPTIONS,
      challenge: CHALLENGE,
      requestId: REQUEST_ID,
    });
  });

  it("verifies a registration response and returns the credential", async () => {
    mocks.readJsonBody.mockResolvedValue({ response: WEB_AUTHN_RESPONSE, name: "My Passkey" });
    const res = createRes();

    await completeRegistrationHandler(createReq(), res);

    expect(mocks.completePasskeyRegistration).toHaveBeenCalledWith(
      USER_ID,
      WEB_AUTHN_RESPONSE,
      "My Passkey"
    );
    expect(res.statusCode).toBe(201);
    expect(responseBody(res)).toMatchObject({
      credential: CREDENTIAL,
      requestId: REQUEST_ID,
    });
  });

  it("rejects an expired registration challenge", async () => {
    mocks.completePasskeyRegistration.mockRejectedValue(
      new PasskeyError("challenge_expired", "WebAuthn challenge has expired.")
    );
    const res = createRes();

    await completeRegistrationHandler(createReq(), res);

    expect(res.statusCode).toBe(400);
    expect(responseBody(res)).toMatchObject({
      data: null,
      error: {
        code: "VALIDATION_ERROR",
        message: "WebAuthn challenge has expired.",
      },
      meta: { requestId: REQUEST_ID },
    });
  });

  it("rejects a registration response from an unexpected origin or RP ID", async () => {
    mocks.completePasskeyRegistration.mockRejectedValue(
      new PasskeyError("verification_failed", "Unexpected WebAuthn origin or RP ID.")
    );
    const res = createRes();

    await completeRegistrationHandler(createReq(), res);

    expect(res.statusCode).toBe(400);
    expect(responseBody(res)).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        message: "Unexpected WebAuthn origin or RP ID.",
      },
    });
  });

  it("returns INTERNAL_ERROR when WebAuthn RP ID or origins are invalid", async () => {
    mocks.beginPasskeyRegistration.mockRejectedValue(
      new PasskeyError("config_error", "WEBAUTHN_RP_ID is not configured.")
    );
    const res = createRes();

    await beginRegistrationHandler(createReq(), res);

    expect(res.statusCode).toBe(500);
    expect(responseBody(res)).toMatchObject({
      data: null,
      error: {
        code: "INTERNAL_ERROR",
        message: "WEBAUTHN_RP_ID is not configured.",
      },
      meta: { requestId: REQUEST_ID },
    });
  });
});

describe("passkey authentication routes", () => {
  it("returns WebAuthn authentication options scoped to the authenticated user", async () => {
    const req = createReq();
    const res = createRes();

    await beginAuthenticationHandler(req, res);

    expect(mocks.getAuthenticatedUserContext).toHaveBeenCalledWith(req);
    expect(mocks.beginPasskeyAuthentication).toHaveBeenCalledWith(USER_ID);
    expect(res.statusCode).toBe(200);
    expect(responseBody(res)).toMatchObject({
      options: AUTHENTICATION_OPTIONS,
      challenge: CHALLENGE,
      requestId: REQUEST_ID,
    });
  });

  it("uses discoverable authentication options without an authenticated user", async () => {
    mocks.getAuthenticatedUserContext.mockReturnValue(undefined);
    const res = createRes();

    await beginAuthenticationHandler(createReq(), res);

    expect(mocks.beginPasskeyAuthentication).toHaveBeenCalledWith(undefined);
    expect(res.statusCode).toBe(200);
    expect(responseBody(res)).toMatchObject({
      options: AUTHENTICATION_OPTIONS,
      challenge: CHALLENGE,
    });
  });

  it("verifies an authentication assertion and issues a token pair", async () => {
    const res = createRes();

    await completeAuthenticationHandler(createReq(), res);

    expect(mocks.completePasskeyAuthentication).toHaveBeenCalledWith(WEB_AUTHN_RESPONSE);
    expect(mocks.findUserByPk).toHaveBeenCalledWith(USER_ID);
    expect(mocks.issueTokenPair).toHaveBeenCalledWith(USER_ID, USER_EMAIL, { roles: ["user"] });
    expect(res.statusCode).toBe(200);
    expect(responseBody(res)).toMatchObject({
      verified: true,
      userId: USER_ID,
      email: USER_EMAIL,
      userVerified: true,
      ...TOKENS,
      requestId: REQUEST_ID,
    });
  });

  it("rejects an expired authentication challenge", async () => {
    mocks.completePasskeyAuthentication.mockRejectedValue(
      new PasskeyError("challenge_expired", "WebAuthn challenge has expired.")
    );
    const res = createRes();

    await completeAuthenticationHandler(createReq(), res);

    expect(res.statusCode).toBe(400);
    expect(responseBody(res)).toMatchObject({
      data: null,
      error: {
        code: "VALIDATION_ERROR",
        message: "WebAuthn challenge has expired.",
      },
      meta: { requestId: REQUEST_ID },
    });
    expect(mocks.issueTokenPair).not.toHaveBeenCalled();
  });

  it("rejects an authentication assertion from an unexpected origin or RP ID", async () => {
    mocks.completePasskeyAuthentication.mockRejectedValue(
      new PasskeyError("verification_failed", "Unexpected WebAuthn origin or RP ID.")
    );
    const res = createRes();

    await completeAuthenticationHandler(createReq(), res);

    expect(res.statusCode).toBe(401);
    expect(responseBody(res)).toMatchObject({
      data: null,
      error: {
        code: "UNAUTHORIZED",
        message: "Unexpected WebAuthn origin or RP ID.",
      },
      meta: { requestId: REQUEST_ID },
    });
    expect(mocks.issueTokenPair).not.toHaveBeenCalled();
  });

  it("rejects a replayed authentication assertion", async () => {
    mocks.completePasskeyAuthentication.mockRejectedValue(
      new PasskeyError("replay_detected", "Passkey signature counter did not advance.")
    );
    const res = createRes();

    await completeAuthenticationHandler(createReq(), res);

    expect(res.statusCode).toBe(401);
    expect(responseBody(res)).toMatchObject({
      error: {
        code: "UNAUTHORIZED",
        message: "Passkey signature counter did not advance.",
      },
    });
    expect(mocks.issueTokenPair).not.toHaveBeenCalled();
  });

  it("returns INTERNAL_ERROR when WebAuthn RP ID or origins are invalid", async () => {
    mocks.beginPasskeyAuthentication.mockRejectedValue(
      new PasskeyError("config_error", "WEBAUTHN_ORIGINS is not configured.")
    );
    const res = createRes();

    await beginAuthenticationHandler(createReq(), res);

    expect(res.statusCode).toBe(500);
    expect(responseBody(res)).toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        message: "WEBAUTHN_ORIGINS is not configured.",
      },
    });
  });
});

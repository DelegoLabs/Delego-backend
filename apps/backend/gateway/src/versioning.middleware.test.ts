/**
 * Tests for:
 *   - src/middleware/versioning.ts  (versionNegotiationMiddleware, versionDiscoveryHandler)
 *   - src/versionedRouter.ts        (buildVersionedRoutes, resolvePath)
 *
 * Uses lightweight IncomingMessage / ServerResponse mocks so no real HTTP
 * server is needed.
 *
 * Issue #54
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Mock @delegolabs/utils so this test file doesn't require the package to
// be built. The real package is only available after `pnpm build`.
// ---------------------------------------------------------------------------
vi.mock("@delegolabs/utils", () => ({
  json: (res: ServerResponse, status: number, body: unknown) => {
    const mock = res as unknown as { _status: number; _body: string; writeHead: (s: number, h?: Record<string,string>) => void; end: (b: string) => void };
    mock.writeHead(status, { "Content-Type": "application/json" });
    mock.end(JSON.stringify(body));
  },
  route: (method: string, path: string, handler: unknown) => {
    // Convert /:param to regex capture group (simplified)
    const paramNames: string[] = [];
    const pattern = new RegExp(
      "^" +
        path.replace(/:([a-zA-Z]+)/g, (_: string, name: string) => {
          paramNames.push(name);
          return "([^/]+)";
        }) +
        "$",
    );
    return { method: method.toUpperCase(), pattern, paramNames, handler };
  },
}));

import {
  versionNegotiationMiddleware,
  versionDiscoveryHandler,
  getVersionContext,
} from "./middleware/versioning.js";
import { buildVersionedRoutes, resolvePath } from "./versionedRouter.js";
import {
  registerVersion,
  resetVersionRegistry,
  type ApiVersion,
  type VersionedRoute,
} from "./versioning.js";

// ---------------------------------------------------------------------------
// Registry fixture
// ---------------------------------------------------------------------------

const V1: ApiVersion = {
  version: "v1",
  status: "active",
  releasedAt: "2026-01-01",
  compatibleWith: [],
};

const V2_DEPRECATED: ApiVersion = {
  version: "v2",
  status: "deprecated",
  releasedAt: "2026-04-01",
  deprecatedAt: "2026-07-01",
  sunsetAt: "2027-01-01",
  compatibleWith: ["v1"],
};

const V3_SUNSET: ApiVersion = {
  version: "v3",
  status: "sunset",
  releasedAt: "2025-01-01",
  deprecatedAt: "2025-06-01",
  sunsetAt: "2025-12-31",
  compatibleWith: [],
};

beforeEach(() => {
  resetVersionRegistry();
  registerVersion(V1);
  registerVersion(V2_DEPRECATED);
  registerVersion(V3_SUNSET);
});

afterEach(() => {
  resetVersionRegistry();
  registerVersion(V1); // leave registry clean for other files
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeRequest(opts: {
  url?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const emitter = new EventEmitter() as unknown as IncomingMessage;
  emitter.url = opts.url ?? "/";
  emitter.headers = { host: "localhost", ...opts.headers } as IncomingMessage["headers"];
  emitter.method = "GET";
  return emitter;
}

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writtenHead: boolean;
}

function makeResponse(): { res: ServerResponse; mock: MockResponse } {
  const mock: MockResponse = { statusCode: 200, headers: {}, body: "", writtenHead: false };

  const res = {
    setHeader: (name: string, value: string) => {
      mock.headers[name] = value;
    },
    getHeader: (name: string) => mock.headers[name],
    headersSent: false,
    writeHead: (status: number, headers?: Record<string, string>) => {
      mock.writtenHead = true;
      mock.statusCode = status;
      if (headers) Object.assign(mock.headers, headers);
    },
    end: (body: string) => {
      mock.body = body;
    },
  } as unknown as ServerResponse;

  return { res, mock };
}

// ---------------------------------------------------------------------------
// versionNegotiationMiddleware
// ---------------------------------------------------------------------------

describe("versionNegotiationMiddleware", () => {
  const mw = versionNegotiationMiddleware();

  describe("version extraction — URL path", () => {
    it("recognises /api/v1/ prefix and attaches v1 context", () => {
      const req = makeRequest({ url: "/api/v1/status" });
      const { res, mock } = makeResponse();
      const next = vi.fn();

      mw(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalledWith(); // no error
      const ctx = getVersionContext(req);
      expect(ctx?.version).toBe("v1");
      expect(ctx?.negotiated).toBe(true);
      expect(mock.headers["X-API-Version"]).toBe("v1");
    });

    it("recognises uppercase V1 in URL", () => {
      const req = makeRequest({ url: "/api/V1/status" });
      const { res } = makeResponse();
      const next = vi.fn();

      mw(req, res, next);
      expect(getVersionContext(req)?.version).toBe("v1");
    });

    it("falls back to latest active when path has no version segment", () => {
      const req = makeRequest({ url: "/api/status" });
      const { res } = makeResponse();
      const next = vi.fn();

      mw(req, res, next);
      const ctx = getVersionContext(req);
      expect(ctx?.version).toBe("v1"); // only active version
      expect(ctx?.negotiated).toBe(false);
    });
  });

  describe("version extraction — Accept header", () => {
    it("reads version from vnd media type", () => {
      const req = makeRequest({
        url: "/api/status",
        headers: { accept: "application/vnd.delego.v1+json" },
      });
      const { res } = makeResponse();
      const next = vi.fn();

      mw(req, res, next);
      expect(getVersionContext(req)?.version).toBe("v1");
      expect(getVersionContext(req)?.negotiated).toBe(true);
    });
  });

  describe("version extraction — X-API-Version header", () => {
    it("reads version from X-API-Version header", () => {
      const req = makeRequest({
        url: "/api/status",
        headers: { "x-api-version": "v1" },
      });
      const { res } = makeResponse();
      const next = vi.fn();

      mw(req, res, next);
      expect(getVersionContext(req)?.version).toBe("v1");
    });

    it("accepts plain integer in header", () => {
      const req = makeRequest({
        url: "/",
        headers: { "x-api-version": "1" },
      });
      const { res } = makeResponse();
      const next = vi.fn();

      mw(req, res, next);
      expect(getVersionContext(req)?.version).toBe("v1");
    });
  });

  describe("version extraction — priority", () => {
    it("URL path takes priority over Accept header", () => {
      const req = makeRequest({
        url: "/api/v1/status",
        headers: { accept: "application/vnd.delego.v2+json" },
      });
      const { res } = makeResponse();
      const next = vi.fn();

      mw(req, res, next);
      expect(getVersionContext(req)?.version).toBe("v1");
    });

    it("Accept header takes priority over X-API-Version", () => {
      const req = makeRequest({
        url: "/api/status",
        headers: {
          accept: "application/vnd.delego.v1+json",
          "x-api-version": "v2",
        },
      });
      const { res } = makeResponse();
      const next = vi.fn();

      mw(req, res, next);
      expect(getVersionContext(req)?.version).toBe("v1");
    });
  });

  describe("deprecated version warnings", () => {
    it("sets deprecation headers for deprecated version", () => {
      const req = makeRequest({ url: "/api/v2/status" });
      const { res, mock } = makeResponse();
      const next = vi.fn();

      mw(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(mock.headers["X-API-Deprecated"]).toBe("true");
      expect(mock.headers["Deprecation"]).toBe("2026-07-01");
      expect(mock.headers["Sunset"]).toBe("2027-01-01");
      expect(mock.headers["Warning"]).toMatch(/deprecated/i);
    });
  });

  describe("sunset enforcement → 410 Gone", () => {
    it("returns 410 for sunset version and does NOT call next()", () => {
      const req = makeRequest({ url: "/api/v3/resource" });
      const { res, mock } = makeResponse();
      const next = vi.fn();

      mw(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(mock.statusCode).toBe(410);
      const body = JSON.parse(mock.body);
      expect(body.error.code).toBe("API_VERSION_GONE");
      expect(body.error.details.requestedVersion).toBe("v3");
    });

    it("includes the latest version in the 410 response", () => {
      const req = makeRequest({ url: "/api/v3/resource" });
      const { res, mock } = makeResponse();
      const next = vi.fn();

      mw(req, res, next);

      const body = JSON.parse(mock.body);
      expect(body.error.details.latestVersion).toBe("v1");
    });
  });

  describe("fallback to latest active", () => {
    it("defaults to latest active when no version specified", () => {
      const req = makeRequest({ url: "/api/status" });
      const { res } = makeResponse();
      const next = vi.fn();

      mw(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      const ctx = getVersionContext(req);
      expect(ctx?.negotiated).toBe(false);
      expect(ctx?.version).toBe("v1");
    });

    it("falls back to latest active for unrecognised version slug", () => {
      const req = makeRequest({ url: "/api/v99/resource" });
      const { res } = makeResponse();
      const next = vi.fn();

      mw(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(getVersionContext(req)?.version).toBe("v1");
    });
  });

  describe("response headers — always present", () => {
    it("sets X-API-Version and X-API-Latest-Version on every request", () => {
      const req = makeRequest({ url: "/api/status" });
      const { res, mock } = makeResponse();
      const next = vi.fn();

      mw(req, res, next);

      expect(mock.headers["X-API-Version"]).toBeDefined();
      expect(mock.headers["X-API-Latest-Version"]).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// versionDiscoveryHandler
// ---------------------------------------------------------------------------

describe("versionDiscoveryHandler", () => {
  it("returns all registered versions with metadata", () => {
    const req = makeRequest({ url: "/api/versions" });
    const { res, mock } = makeResponse();

    versionDiscoveryHandler(req, res);

    expect(mock.statusCode).toBe(200);
    const body = JSON.parse(mock.body);
    const slugs: string[] = body.data.versions.map((v: ApiVersion) => v.version);
    expect(slugs).toContain("v1");
    expect(slugs).toContain("v2");
    expect(slugs).toContain("v3");
  });

  it("includes latestVersion in the response", () => {
    const req = makeRequest({ url: "/api/versions" });
    const { res, mock } = makeResponse();

    versionDiscoveryHandler(req, res);

    const body = JSON.parse(mock.body);
    expect(body.data.latestVersion).toBe("v1");
  });

  it("includes version status and dates", () => {
    const req = makeRequest({ url: "/api/versions" });
    const { res, mock } = makeResponse();

    versionDiscoveryHandler(req, res);

    const body = JSON.parse(mock.body);
    const v2 = body.data.versions.find((v: ApiVersion) => v.version === "v2");
    expect(v2.status).toBe("deprecated");
    expect(v2.deprecatedAt).toBe("2026-07-01");
    expect(v2.sunsetAt).toBe("2027-01-01");
  });

  it("returns error:null in the envelope", () => {
    const req = makeRequest({ url: "/api/versions" });
    const { res, mock } = makeResponse();

    versionDiscoveryHandler(req, res);

    const body = JSON.parse(mock.body);
    expect(body.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolvePath
// ---------------------------------------------------------------------------

describe("resolvePath", () => {
  it("replaces :version placeholder with the slug", () => {
    expect(resolvePath("/api/:version/status", "v1")).toBe("/api/v1/status");
    expect(resolvePath("/api/:version/users/:id", "v2")).toBe("/api/v2/users/:id");
  });

  it("leaves already-versioned /api/v<n>/… paths unchanged", () => {
    expect(resolvePath("/api/v1/status", "v1")).toBe("/api/v1/status");
  });

  it("inserts slug after /api/ prefix", () => {
    expect(resolvePath("/api/status", "v1")).toBe("/api/v1/status");
    expect(resolvePath("/api/users", "v2")).toBe("/api/v2/users");
  });

  it("prepends /api/<slug> for bare paths", () => {
    expect(resolvePath("/status", "v1")).toBe("/api/v1/status");
    expect(resolvePath("users", "v1")).toBe("/api/v1/users");
  });
});

// ---------------------------------------------------------------------------
// buildVersionedRoutes
// ---------------------------------------------------------------------------

describe("buildVersionedRoutes", () => {
  it("creates one Route per supported version", () => {
    const decl: VersionedRoute = {
      path: "/api/:version/ping",
      method: "GET",
      versions: ["v1", "v2"],
      handler: async (_req, _res, _v) => {},
    };

    const routes = buildVersionedRoutes([decl]);
    // v3 is sunset → skipped; v1 and v2 are supported
    expect(routes).toHaveLength(2);
  });

  it("skips sunset versions", () => {
    const decl: VersionedRoute = {
      path: "/api/:version/ping",
      method: "GET",
      versions: ["v1", "v3"],
      handler: async (_req, _res, _v) => {},
    };

    const routes = buildVersionedRoutes([decl]);
    expect(routes).toHaveLength(1); // only v1
  });

  it("passes resolved version to handler", async () => {
    const receivedVersions: string[] = [];
    const decl: VersionedRoute = {
      path: "/api/:version/ping",
      method: "GET",
      versions: ["v1"],
      handler: async (_req, _res, version) => {
        receivedVersions.push(version);
      },
    };

    const routes = buildVersionedRoutes([decl]);
    expect(routes).toHaveLength(1);

    const req = makeRequest({ url: "/api/v1/ping" });
    const { res } = makeResponse();
    await routes[0].handler(req, res, {});

    expect(receivedVersions).toEqual(["v1"]);
  });

  it("expands multiple declarations", () => {
    const declarations: VersionedRoute[] = [
      {
        path: "/api/:version/a",
        method: "GET",
        versions: ["v1"],
        handler: async () => {},
      },
      {
        path: "/api/:version/b",
        method: "POST",
        versions: ["v1", "v2"],
        handler: async () => {},
      },
    ];

    const routes = buildVersionedRoutes(declarations);
    expect(routes).toHaveLength(3); // 1 + 2
  });

  it("normalises method to uppercase", () => {
    const decl: VersionedRoute = {
      path: "/api/:version/test",
      method: "get",
      versions: ["v1"],
      handler: async () => {},
    };

    const routes = buildVersionedRoutes([decl]);
    expect(routes[0].method).toBe("GET");
  });
});

/**
 * Tests for src/versioning.ts — version registry, negotiation, and header building.
 * Issue #54
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getVersion,
  getAllVersions,
  getActiveVersions,
  getLatestActiveVersion,
  isVersionSupported,
  isVersionDeprecated,
  isVersionSunset,
  registerVersion,
  resetVersionRegistry,
  parseVersionSlug,
  parseVersionFromAcceptHeader,
  negotiateVersion,
  buildVersionHeaders,
  type ApiVersion,
} from "./versioning.js";

// ---------------------------------------------------------------------------
// Registry setup helpers
// ---------------------------------------------------------------------------

const V1_ACTIVE: ApiVersion = {
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

const V4_ACTIVE: ApiVersion = {
  version: "v4",
  status: "active",
  releasedAt: "2026-08-01",
  compatibleWith: ["v1", "v2"],
};

// ---------------------------------------------------------------------------
// Suite helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Start every test with a clean registry
  resetVersionRegistry();
});

afterEach(() => {
  // Restore defaults so other test files aren't affected
  resetVersionRegistry();
  registerVersion(V1_ACTIVE);
});

// ---------------------------------------------------------------------------
// parseVersionSlug
// ---------------------------------------------------------------------------

describe("parseVersionSlug", () => {
  it("accepts 'v1' (lowercase)", () => {
    expect(parseVersionSlug("v1")).toBe("v1");
  });

  it("accepts 'V2' and normalises to lowercase", () => {
    expect(parseVersionSlug("V2")).toBe("v2");
  });

  it("accepts a plain integer and prepends 'v'", () => {
    expect(parseVersionSlug("3")).toBe("v3");
  });

  it("accepts multi-digit versions", () => {
    expect(parseVersionSlug("10")).toBe("v10");
    expect(parseVersionSlug("v10")).toBe("v10");
  });

  it("trims surrounding whitespace", () => {
    expect(parseVersionSlug("  v1  ")).toBe("v1");
  });

  it("returns null for 'v1.0.0' (semver format not accepted)", () => {
    expect(parseVersionSlug("v1.0.0")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseVersionSlug("")).toBeNull();
  });

  it("returns null for arbitrary strings", () => {
    expect(parseVersionSlug("latest")).toBeNull();
    expect(parseVersionSlug("api")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseVersionFromAcceptHeader
// ---------------------------------------------------------------------------

describe("parseVersionFromAcceptHeader", () => {
  it("extracts version from vnd media type", () => {
    expect(parseVersionFromAcceptHeader("application/vnd.delego.v1+json")).toBe("v1");
    expect(parseVersionFromAcceptHeader("application/vnd.delego.v2+json")).toBe("v2");
  });

  it("is case-insensitive", () => {
    expect(parseVersionFromAcceptHeader("application/vnd.DELEGO.V1+json")).toBe("v1");
  });

  it("ignores other media types", () => {
    expect(parseVersionFromAcceptHeader("application/json")).toBeNull();
    expect(parseVersionFromAcceptHeader("text/html")).toBeNull();
  });

  it("returns null when header is empty", () => {
    expect(parseVersionFromAcceptHeader("")).toBeNull();
  });

  it("works with multiple values (first vnd match wins)", () => {
    const header = "text/html, application/vnd.delego.v2+json, application/json";
    expect(parseVersionFromAcceptHeader(header)).toBe("v2");
  });
});

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

describe("version registry", () => {
  describe("registerVersion / getVersion", () => {
    it("registers a new version and retrieves it", () => {
      registerVersion(V1_ACTIVE);
      expect(getVersion("v1")).toEqual(V1_ACTIVE);
    });

    it("updates an existing version entry", () => {
      registerVersion(V1_ACTIVE);
      const updated: ApiVersion = { ...V1_ACTIVE, status: "deprecated", deprecatedAt: "2026-06-01" };
      registerVersion(updated);
      expect(getVersion("v1")?.status).toBe("deprecated");
    });

    it("returns undefined for unknown slug", () => {
      expect(getVersion("v99")).toBeUndefined();
    });
  });

  describe("getAllVersions", () => {
    it("returns all registered versions", () => {
      registerVersion(V1_ACTIVE);
      registerVersion(V2_DEPRECATED);
      const all = getAllVersions();
      expect(all).toHaveLength(2);
      expect(all.map((v) => v.version)).toEqual(["v1", "v2"]);
    });

    it("returns stable copies (mutations don't affect registry)", () => {
      registerVersion(V1_ACTIVE);
      const all = getAllVersions();
      all[0].status = "sunset";
      expect(getVersion("v1")?.status).toBe("active");
    });
  });

  describe("getActiveVersions", () => {
    it("returns only active versions", () => {
      registerVersion(V1_ACTIVE);
      registerVersion(V2_DEPRECATED);
      registerVersion(V3_SUNSET);
      const active = getActiveVersions();
      expect(active.map((v) => v.version)).toEqual(["v1"]);
    });
  });

  describe("getLatestActiveVersion", () => {
    it("returns the last active version (registry order)", () => {
      registerVersion(V1_ACTIVE);
      registerVersion(V4_ACTIVE);
      expect(getLatestActiveVersion().version).toBe("v4");
    });

    it("throws when no active versions are registered", () => {
      registerVersion(V3_SUNSET);
      expect(() => getLatestActiveVersion()).toThrow();
    });
  });

  describe("isVersionSupported / isVersionDeprecated / isVersionSunset", () => {
    beforeEach(() => {
      registerVersion(V1_ACTIVE);
      registerVersion(V2_DEPRECATED);
      registerVersion(V3_SUNSET);
    });

    it("reports active as supported and not deprecated/sunset", () => {
      expect(isVersionSupported("v1")).toBe(true);
      expect(isVersionDeprecated("v1")).toBe(false);
      expect(isVersionSunset("v1")).toBe(false);
    });

    it("reports deprecated as supported and deprecated but not sunset", () => {
      expect(isVersionSupported("v2")).toBe(true);
      expect(isVersionDeprecated("v2")).toBe(true);
      expect(isVersionSunset("v2")).toBe(false);
    });

    it("reports sunset as not supported and sunset", () => {
      expect(isVersionSupported("v3")).toBe(false);
      expect(isVersionDeprecated("v3")).toBe(false);
      expect(isVersionSunset("v3")).toBe(true);
    });

    it("reports unknown slug as not supported", () => {
      expect(isVersionSupported("v99")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// negotiateVersion
// ---------------------------------------------------------------------------

describe("negotiateVersion", () => {
  beforeEach(() => {
    registerVersion(V1_ACTIVE);
    registerVersion(V2_DEPRECATED);
    registerVersion(V3_SUNSET);
    registerVersion(V4_ACTIVE);
  });

  describe("no requested version → latest active default", () => {
    it("returns the latest active version when slug is null", () => {
      const result = negotiateVersion(null);
      expect(result.version).toBe("v4");
      expect(result.negotiated).toBe(false);
      expect(result.deprecated).toBe(false);
    });

    it("unrecognised slug also falls back to latest active", () => {
      const result = negotiateVersion("v99");
      expect(result.version).toBe("v4");
      expect(result.negotiated).toBe(false);
    });

    it("non-slug string falls back to latest active", () => {
      const result = negotiateVersion("banana");
      expect(result.version).toBe("v4");
    });
  });

  describe("active version requested", () => {
    it("returns the requested active version", () => {
      const result = negotiateVersion("v1");
      expect(result.version).toBe("v1");
      expect(result.negotiated).toBe(true);
      expect(result.deprecated).toBe(false);
      expect(result.warningHeader).toBeUndefined();
    });

    it("accepts plain integer slug '1' → resolves to v1", () => {
      const result = negotiateVersion("1");
      expect(result.version).toBe("v1");
      expect(result.negotiated).toBe(true);
    });

    it("accepts uppercase 'V1' → resolves to v1", () => {
      const result = negotiateVersion("V1");
      expect(result.version).toBe("v1");
    });
  });

  describe("deprecated version requested", () => {
    it("serves deprecated version with warning", () => {
      const result = negotiateVersion("v2");
      expect(result.version).toBe("v2");
      expect(result.negotiated).toBe(true);
      expect(result.deprecated).toBe(true);
      expect(result.sunsetDate).toBe("2027-01-01");
      expect(result.warningHeader).toMatch(/deprecated/i);
    });
  });

  describe("sunset version requested", () => {
    it("returns sunset version details so middleware can issue 410", () => {
      const result = negotiateVersion("v3");
      expect(result.version).toBe("v3");
      expect(result.negotiated).toBe(true);
      expect(result.deprecated).toBe(true);
      expect(result.warningHeader).toMatch(/retired/i);
    });
  });
});

// ---------------------------------------------------------------------------
// buildVersionHeaders
// ---------------------------------------------------------------------------

describe("buildVersionHeaders", () => {
  beforeEach(() => {
    registerVersion(V1_ACTIVE);
    registerVersion(V2_DEPRECATED);
    registerVersion(V4_ACTIVE);
  });

  it("always includes X-API-Version and X-API-Latest-Version", () => {
    const result = negotiateVersion("v1");
    const headers = buildVersionHeaders(result);
    expect(headers["X-API-Version"]).toBe("v1");
    expect(headers["X-API-Latest-Version"]).toBe("v4");
  });

  it("omits deprecation headers for active versions", () => {
    const result = negotiateVersion("v1");
    const headers = buildVersionHeaders(result);
    expect(headers["X-API-Deprecated"]).toBeUndefined();
    expect(headers["Deprecation"]).toBeUndefined();
    expect(headers["Sunset"]).toBeUndefined();
  });

  it("adds Deprecation, Sunset, X-API-Deprecated, Warning for deprecated version", () => {
    const result = negotiateVersion("v2");
    const headers = buildVersionHeaders(result);
    expect(headers["X-API-Deprecated"]).toBe("true");
    expect(headers["Deprecation"]).toBe("2026-07-01");
    expect(headers["Sunset"]).toBe("2027-01-01");
    expect(headers["X-API-Sunset"]).toBe("2027-01-01");
    expect(headers["Warning"]).toMatch(/deprecated/i);
  });

  it("reflects latest-version correctly when fallback is used", () => {
    const result = negotiateVersion(null);
    const headers = buildVersionHeaders(result);
    expect(headers["X-API-Version"]).toBe("v4");
    expect(headers["X-API-Latest-Version"]).toBe("v4");
  });
});

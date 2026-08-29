import { describe, it, expect } from "vitest";
import {
  parseVersion,
  formatVersion,
  negotiateVersion,
  getCurrentVersion,
  getSupportedVersions,
  getDeprecationHeaders,
  getVersionCompatibilityMatrix,
  type ApiVersion,
} from "./versioning.js";

describe("API Versioning", () => {
  describe("parseVersion", () => {
    it("parses a legacy semver string and a Delego v-prefix string", () => {
      expect(parseVersion("1.0.0")).toBe("v1");
      expect(parseVersion("v2")).toBe("v2");
      expect(parseVersion("application/vnd.delego.v1+json")).toBe("v1");
      expect(parseVersion("/api/v1/users")).toBe("v1");
    });

    it("returns null for invalid version strings", () => {
      expect(parseVersion("invalid")).toBeNull();
      expect(parseVersion("v0")).toBeNull();
      expect(parseVersion("")).toBeNull();
    });
  });

  describe("formatVersion", () => {
    it("formats the version string correctly", () => {
      const version: ApiVersion = {
        version: "v2",
        status: "active",
        releasedAt: "2025-01-01T00:00:00.000Z",
        compatibleWith: ["v1", "v2"],
      };
      expect(formatVersion(version)).toBe("v2");
    });
  });

  describe("negotiateVersion", () => {
    it("defaults to the latest active version when no version is requested", () => {
      const result = negotiateVersion(null);
      expect(result.version).toBe("v2");
      expect(result.negotiated).toBe(false);
      expect(result.deprecated).toBe(false);
    });

    it("accepts a supported version in the Accept header and a URL path", () => {
      expect(negotiateVersion("application/vnd.delego.v1+json").version).toBe("v1");
      expect(negotiateVersion("/api/v1/users").version).toBe("v1");
    });

    it("falls back to the latest active version when an unsupported version is requested", () => {
      const result = negotiateVersion("v9");
      expect(result.version).toBe("v2");
      expect(result.negotiated).toBe(false);
    });

    it("marks deprecated versions and returns a warning header", () => {
      const result = negotiateVersion("v1");
      expect(result.version).toBe("v1");
      expect(result.deprecated).toBe(true);
      expect(result.warningHeader).toContain("deprecated");
    });
  });

  describe("getCurrentVersion", () => {
    it("returns the current version", () => {
      expect(getCurrentVersion().version).toBe("v2");
    });
  });

  describe("getSupportedVersions", () => {
    it("returns active and deprecated entries in version order", () => {
      const versions = getSupportedVersions();
      expect(versions.map((entry) => entry.version)).toEqual(["v1", "v2"]);
    });
  });

  describe("matrix and headers", () => {
    it("exposes the compatibility matrix and deprecation headers", () => {
      const matrix = getVersionCompatibilityMatrix();
      expect(matrix).toHaveProperty("v1");
      expect(matrix).toHaveProperty("v2");

      const headers = getDeprecationHeaders("v1");
      expect(headers["X-API-Version"]).toBe("v1");
      expect(headers["X-API-Current-Version"]).toBe("v2");
      expect(headers["Deprecation"]).toContain("2025");
    });
  });
});
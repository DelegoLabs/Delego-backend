/**
 * API Versioning — types, registry, and negotiation logic.
 *
 * Versions are identified by a slug string ("v1", "v2", …).
 * The registry tracks status, compatibility, and sunset dates.
 * Version negotiation reads the slug from the URL path, Accept header,
 * or X-API-Version header and falls back to the latest active version.
 *
 * Issue #54
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VersionStatus = "active" | "deprecated" | "sunset";

export interface ApiVersion {
  /** Slug identifier, e.g. "v1", "v2" */
  version: string;
  status: VersionStatus;
  /** ISO-8601 date the version was released */
  releasedAt: string;
  /** ISO-8601 date the version was declared deprecated (optional) */
  deprecatedAt?: string;
  /** ISO-8601 date the version will no longer be served (optional) */
  sunsetAt?: string;
  /** Slugs of other versions this one is backwards-compatible with */
  compatibleWith: string[];
}

export interface VersionedRoute {
  path: string;
  method: string;
  /** Which version slugs this handler covers */
  versions: string[];
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    version: string,
  ) => Promise<void>;
  deprecated?: boolean;
}

export interface VersionNegotiationResult {
  /** The resolved version slug */
  version: string;
  /** True when the client explicitly requested a version (rather than the default) */
  negotiated: boolean;
  deprecated: boolean;
  sunsetDate?: string;
  /** RFC 9110 Warning header value, set when version is deprecated */
  warningHeader?: string;
}

// ---------------------------------------------------------------------------
// Version registry
// ---------------------------------------------------------------------------

/**
 * All known API versions, ordered from oldest to newest.
 * "v1" is the only currently active version; add "v2" here once it ships.
 */
const VERSION_REGISTRY: ApiVersion[] = [
  {
    version: "v1",
    status: "active",
    releasedAt: "2026-01-01",
    compatibleWith: [],
  },
];

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

/** Look up a version by its slug. Returns undefined if not found. */
export function getVersion(slug: string): ApiVersion | undefined {
  return VERSION_REGISTRY.find((v) => v.version === slug);
}

/** Return all registered versions (stable copy). */
export function getAllVersions(): ApiVersion[] {
  return VERSION_REGISTRY.map((v) => ({ ...v }));
}

/** Return all versions whose status is "active". */
export function getActiveVersions(): ApiVersion[] {
  return VERSION_REGISTRY.filter((v) => v.status === "active").map((v) => ({ ...v }));
}

/** Return the latest active version (last in registry order). */
export function getLatestActiveVersion(): ApiVersion {
  const active = VERSION_REGISTRY.filter((v) => v.status === "active");
  if (active.length === 0) {
    throw new Error("No active API versions registered");
  }
  return { ...active[active.length - 1] };
}

/** Return true if the slug refers to a known, non-sunset version. */
export function isVersionSupported(slug: string): boolean {
  const v = getVersion(slug);
  return v !== undefined && v.status !== "sunset";
}

/** Return true if the slug refers to a deprecated version. */
export function isVersionDeprecated(slug: string): boolean {
  const v = getVersion(slug);
  return v?.status === "deprecated";
}

/** Return true if the slug refers to a sunset (gone) version. */
export function isVersionSunset(slug: string): boolean {
  const v = getVersion(slug);
  return v?.status === "sunset";
}

/**
 * Register (or update) a version entry at runtime.
 * Useful for tests and for dynamic registration from config.
 */
export function registerVersion(entry: ApiVersion): void {
  const idx = VERSION_REGISTRY.findIndex((v) => v.version === entry.version);
  if (idx >= 0) {
    VERSION_REGISTRY[idx] = { ...entry };
  } else {
    VERSION_REGISTRY.push({ ...entry });
  }
}

/**
 * Remove all versions from the registry.
 * Only intended for use in tests — do not call in production code.
 */
export function resetVersionRegistry(): void {
  VERSION_REGISTRY.length = 0;
}

// ---------------------------------------------------------------------------
// Version slug parsing
// ---------------------------------------------------------------------------

/**
 * Normalise an incoming version token to a lowercase slug.
 *
 * Accepts:
 *   - "v1", "V1", "v2"                → "v1", "v2"
 *   - plain integers: "1", "2"         → "v1", "v2"
 *
 * Returns null for anything else.
 */
export function parseVersionSlug(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (/^v\d+$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `v${trimmed}`;
  return null;
}

/**
 * Extract an API version slug from an Accept header value.
 *
 * Recognises the Delego vendor media type:
 *   application/vnd.delego.v1+json
 *   application/vnd.delego.v2+json
 */
export function parseVersionFromAcceptHeader(acceptHeader: string): string | null {
  const match = acceptHeader.match(/application\/vnd\.delego\.(v\d+)\+json/i);
  if (match) return match[1].toLowerCase();
  return null;
}

// ---------------------------------------------------------------------------
// Core negotiation
// ---------------------------------------------------------------------------

/**
 * Negotiate which API version to use given a raw version token (or null).
 *
 * Resolution order:
 *   1. If a token is provided and resolves to a known slug:
 *      a. If the version is sunset → caller should return 410 Gone.
 *      b. If the version is deprecated → serve it with warnings.
 *      c. Otherwise → serve it normally.
 *   2. If no token (or the token is unrecognised) → use the latest active version.
 */
export function negotiateVersion(requestedSlug: string | null): VersionNegotiationResult {
  if (requestedSlug !== null) {
    const slug = parseVersionSlug(requestedSlug) ?? requestedSlug.trim().toLowerCase();
    const entry = getVersion(slug);

    if (entry) {
      const isSunset = entry.status === "sunset";
      const isDeprecated = entry.status === "deprecated";

      return {
        version: slug,
        negotiated: true,
        deprecated: isDeprecated || isSunset,
        sunsetDate: entry.sunsetAt,
        warningHeader: isDeprecated
          ? `299 - "API version ${slug} is deprecated. Please migrate to ${getLatestActiveVersion().version}."`
          : isSunset
          ? `299 - "API version ${slug} has been retired. Please use ${getLatestActiveVersion().version}."`
          : undefined,
      };
    }
  }

  // Fall back to latest active version
  const latest = getLatestActiveVersion();
  return {
    version: latest.version,
    negotiated: false,
    deprecated: false,
  };
}

// ---------------------------------------------------------------------------
// Response headers
// ---------------------------------------------------------------------------

/**
 * Build the set of API-version-related response headers for a negotiation result.
 *
 * Always includes:
 *   X-API-Version        — the resolved version
 *   X-API-Latest-Version — the latest active version slug
 *
 * When deprecated or sunset, also includes:
 *   Deprecation          — ISO date when deprecation was announced
 *   Sunset               — ISO date the version will stop being served
 *   X-API-Deprecated     — "true"
 *   Warning              — RFC 9110 warning header
 */
export function buildVersionHeaders(result: VersionNegotiationResult): Record<string, string> {
  const latest = getLatestActiveVersion();
  const headers: Record<string, string> = {
    "X-API-Version": result.version,
    "X-API-Latest-Version": latest.version,
  };

  if (result.deprecated) {
    const entry = getVersion(result.version);
    headers["X-API-Deprecated"] = "true";
    if (entry?.deprecatedAt) headers["Deprecation"] = entry.deprecatedAt;
    if (result.sunsetDate) {
      headers["Sunset"] = result.sunsetDate;
      headers["X-API-Sunset"] = result.sunsetDate;
    }
    if (result.warningHeader) headers["Warning"] = result.warningHeader;
  }

  return headers;
}

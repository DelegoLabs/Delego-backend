export interface ApiVersion {
  version: string;
  status: "active" | "deprecated" | "sunset";
  releasedAt: string;
  deprecatedAt?: string;
  sunsetAt?: string;
  compatibleWith: string[];
}

export interface VersionedRoute {
  path: string;
  method: string;
  versions: string[];
  handler: (req: unknown, res: unknown, version: string) => Promise<void> | void;
  deprecated?: boolean;
}

export interface VersionNegotiationResult {
  version: string;
  negotiated: boolean;
  deprecated: boolean;
  sunsetDate?: string;
  warningHeader?: string;
}

const SUPPORTED_VERSIONS: ApiVersion[] = [
  {
    version: "v1",
    status: "deprecated",
    releasedAt: "2024-01-15T00:00:00.000Z",
    deprecatedAt: "2025-06-01T00:00:00.000Z",
    sunsetAt: "2026-12-31T00:00:00.000Z",
    compatibleWith: ["v1", "v2"],
  },
  {
    version: "v2",
    status: "active",
    releasedAt: "2025-06-01T00:00:00.000Z",
    compatibleWith: ["v1", "v2"],
  },
];

const VERSION_MAP = new Map(SUPPORTED_VERSIONS.map((version) => [version.version, version]));

export function parseVersion(versionStr: string | null | undefined): string | null {
  if (!versionStr) {
    return null;
  }

  const trimmed = versionStr.trim();
  if (!trimmed) {
    return null;
  }

  const acceptMatch = trimmed.match(/application\/vnd\.delego\.v(\d+)(?:\.\d+(?:\.\d+)?)?\+json/i);
  if (acceptMatch) {
    const candidate = `v${acceptMatch[1]}`;
    return VERSION_MAP.has(candidate) ? candidate : null;
  }

  const pathMatch = trimmed.match(/(?:^|\/)(?:api\/)?v(\d+)(?:\.\d+(?:\.\d+)?)?(?:\/|$)/i);
  if (pathMatch) {
    const candidate = `v${pathMatch[1]}`;
    return VERSION_MAP.has(candidate) ? candidate : null;
  }

  const semverMatch = trimmed.match(/^v?(\d+)\.(\d+)(?:\.\d+)?$/i);
  if (semverMatch) {
    const candidate = `v${semverMatch[1]}`;
    return VERSION_MAP.has(candidate) ? candidate : null;
  }

  const explicitMatch = trimmed.match(/^v(\d+)$/i);
  if (explicitMatch) {
    const candidate = `v${explicitMatch[1]}`;
    return VERSION_MAP.has(candidate) ? candidate : null;
  }

  return null;
}

export function formatVersion(version: ApiVersion | string): string {
  if (typeof version === "string") {
    return version;
  }

  return version.version;
}

export function getVersionInfo(version: string): ApiVersion | null {
  return VERSION_MAP.get(version) ?? null;
}

export function isVersionSupported(version: string): boolean {
  return VERSION_MAP.has(version);
}

export function isVersionDeprecated(version: string): boolean {
  const versionInfo = getVersionInfo(version);
  return versionInfo ? versionInfo.status === "deprecated" || versionInfo.status === "sunset" : false;
}

export function getDeprecationInfo(version: string): { deprecationDate?: string; sunsetDate?: string } | null {
  const versionInfo = getVersionInfo(version);
  if (!versionInfo) {
    return null;
  }

  return {
    deprecationDate: versionInfo.deprecatedAt,
    sunsetDate: versionInfo.sunsetAt,
  };
}

export function getCurrentVersion(): ApiVersion {
  const current = SUPPORTED_VERSIONS.find((version) => version.status === "active");
  return current ?? SUPPORTED_VERSIONS[SUPPORTED_VERSIONS.length - 1];
}

export function getSupportedVersions(): ApiVersion[] {
  return SUPPORTED_VERSIONS.map((version) => ({ ...version, compatibleWith: [...version.compatibleWith] }));
}

export function getVersionCompatibilityMatrix(): Record<string, string[]> {
  return Object.fromEntries(
    SUPPORTED_VERSIONS.map((version) => [version.version, [...version.compatibleWith]])
  );
}

function buildWarningHeader(version: ApiVersion): string | undefined {
  const currentVersion = getCurrentVersion();
  if (version.status === "active") {
    return undefined;
  }

  const sunset = version.sunsetAt ?? "unspecified";
  return `299 - "API version ${version.version} is deprecated; upgrade to ${currentVersion.version}; sunset ${sunset}"`;
}

export function negotiateVersion(requestedVersion: string | null): VersionNegotiationResult {
  const current = getCurrentVersion();

  if (!requestedVersion) {
    return {
      version: current.version,
      negotiated: false,
      deprecated: current.status === "deprecated" || current.status === "sunset",
      sunsetDate: current.sunsetAt,
      warningHeader: buildWarningHeader(current),
    };
  }

  const parsed = parseVersion(requestedVersion);
  if (!parsed) {
    return {
      version: current.version,
      negotiated: false,
      deprecated: current.status === "deprecated" || current.status === "sunset",
      sunsetDate: current.sunsetAt,
      warningHeader: buildWarningHeader(current),
    };
  }

  const supported = getVersionInfo(parsed);
  if (!supported) {
    return {
      version: current.version,
      negotiated: false,
      deprecated: current.status === "deprecated" || current.status === "sunset",
      sunsetDate: current.sunsetAt,
      warningHeader: buildWarningHeader(current),
    };
  }

  const sunsetDate = supported.sunsetAt;
  const isDeprecated = supported.status === "deprecated" || supported.status === "sunset";

  return {
    version: supported.version,
    negotiated: true,
    deprecated: isDeprecated,
    sunsetDate,
    warningHeader: buildWarningHeader(supported),
  };
}

export function getDeprecationHeaders(version: string): Record<string, string> {
  const currentVersion = getCurrentVersion();
  const headers: Record<string, string> = {
    "X-API-Version": version,
    "X-API-Current-Version": currentVersion.version,
  };

  const versionInfo = getVersionInfo(version);
  if (!versionInfo) {
    return headers;
  }

  if (versionInfo.deprecatedAt) {
    headers["Deprecation"] = new Date(versionInfo.deprecatedAt).toUTCString();
  }

  if (versionInfo.sunsetAt) {
    headers["Sunset"] = new Date(versionInfo.sunsetAt).toUTCString();
    headers["X-API-Sunset"] = versionInfo.sunsetAt;
  }

  if (versionInfo.status === "deprecated" || versionInfo.status === "sunset") {
    headers["X-API-Deprecated"] = "true";
    headers["Warning"] = buildWarningHeader(versionInfo) ?? "";
  }

  return headers;
}

export function registerDeprecatedVersion(version: string, deprecationDate: string, sunsetDate: string): void {
  const versionInfo = getVersionInfo(version);
  if (!versionInfo) {
    return;
  }

  versionInfo.deprecatedAt = deprecationDate;
  versionInfo.sunsetAt = sunsetDate;
  versionInfo.status = "deprecated";
}

export function getVersionCatalog(): ApiVersion[] {
  return getSupportedVersions();
}
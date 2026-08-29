import { Request, Response, NextFunction } from "express";
import {
  negotiateVersion,
  parseVersion,
  getDeprecationHeaders,
  getCurrentVersion,
  getSupportedVersions,
  type VersionNegotiationResult,
} from "../versioning.js";

declare global {
  namespace Express {
    interface Request {
      apiVersion?: VersionNegotiationResult;
    }
  }
}

export function versioningMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const queryVersion = typeof req.query?.version === "string" ? req.query.version : null;
    const acceptHeader = typeof req.headers.accept === "string" ? req.headers.accept : null;
    const xApiVersionHeader = typeof req.headers["x-api-version"] === "string" ? req.headers["x-api-version"] : null;

    let requestedVersion: string | null = null;

    for (const candidate of [acceptHeader, xApiVersionHeader, queryVersion, req.originalUrl ?? req.url]) {
      const parsed = candidate ? parseVersion(candidate) : null;
      if (parsed) {
        requestedVersion = parsed;
        break;
      }
    }

    if (!requestedVersion) {
      const pathMatch = (req.path ?? req.originalUrl ?? "/").match(/(?:^|\/)(?:api\/)?v(\d+)(?:\/|$)/i);
      if (pathMatch) {
        requestedVersion = `v${pathMatch[1]}`;
      }
    }

    const negotiationResult = negotiateVersion(requestedVersion);
    req.apiVersion = negotiationResult;

    const headers = getDeprecationHeaders(negotiationResult.version);
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }

    if (negotiationResult.warningHeader) {
      res.setHeader("Warning", negotiationResult.warningHeader);
    }

    if (negotiationResult.sunsetDate) {
      const sunsetEpoch = new Date(negotiationResult.sunsetDate).getTime();
      if (Number.isFinite(sunsetEpoch) && sunsetEpoch <= Date.now()) {
        res.status(410);
        res.setHeader("X-API-Version", negotiationResult.version);
        res.json({
          data: null,
          error: {
            code: "API_VERSION_SUNSET",
            message: `API version ${negotiationResult.version} has reached its sunset date and is no longer supported.`,
          },
        });
        return;
      }
    }

    next();
  };
}

export function versionDiscoveryEndpoint() {
  return (req: Request, res: Response) => {
    const currentVersion = req.apiVersion?.version ?? getCurrentVersion().version;
    res.json({
      data: {
        currentVersion,
        supportedVersions: getSupportedVersions().map((version) => ({
          version: version.version,
          status: version.status,
          releasedAt: version.releasedAt,
          deprecatedAt: version.deprecatedAt,
          sunsetAt: version.sunsetAt,
          compatibleWith: version.compatibleWith,
        })),
        deprecationInfo: req.apiVersion?.deprecated
          ? {
              version: req.apiVersion.version,
              sunsetDate: req.apiVersion.sunsetDate,
              warningHeader: req.apiVersion.warningHeader,
            }
          : null,
      },
      error: null,
      meta: {
        requestId: req.headers["x-request-id"] || "unknown",
        timestamp: new Date().toISOString(),
      },
    });
  };
}
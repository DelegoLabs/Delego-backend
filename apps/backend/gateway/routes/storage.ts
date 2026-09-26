/**
 * Storage API routes (Issue #112).
 *
 * Generates short-lived pre-signed URLs for uploading product photos
 * and dispute evidence directly to Cloudflare R2 / AWS S3.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Route, RouteHandler } from "@delegolabs/utils";
import { json, createLogger, route } from "@delegolabs/utils";
import { generatePresignedUrl, checkStorageConfig } from "../src/storage/index.js";
import { readJsonBody } from "../src/request.js";
import type { PresignedUrlRequest, PresignedUrlResponse } from "../src/storage/index.js";

const log = createLogger("gateway:storage", process.env.LOG_LEVEL ?? "info");

/**
 * Storage status handler.
 * Returns configuration status for the storage system.
 */
export const storageStatusHandler: RouteHandler = (_req, res) => {
  const config = checkStorageConfig();

  if (!config.configured) {
    json(res, 503, {
      data: null,
      error: {
        code: "STORAGE_NOT_CONFIGURED",
        message: "Storage is not fully configured",
        missing: config.missing,
      },
    });
    return;
  }

  json(res, 200, {
    data: {
      configured: true,
      bucket: process.env.STORAGE_BUCKET_NAME,
      region: process.env.STORAGE_REGION,
      endpoint: process.env.STORAGE_ENDPOINT || null,
    },
    error: null,
  });
};

/**
 * Generate pre-signed URL handler.
 *
 * POST /api/v1/storage/presigned-url
 */
export const generatePresignedUrlHandler: RouteHandler = async (req, res) => {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    json(res, 400, {
      data: null,
      error: { code: "INVALID_JSON", message: "Invalid JSON body" },
    });
    return;
  }

  if (!body || typeof body !== "object") {
    json(res, 400, {
      data: null,
      error: { code: "INVALID_REQUEST", message: "Request body is required" },
    });
    return;
  }

  const request = body as PresignedUrlRequest;

  // Validate required fields
  if (!request.filename || typeof request.filename !== "string") {
    json(res, 400, {
      data: null,
      error: { code: "INVALID_REQUEST", message: "filename is required and must be a string" },
    });
    return;
  }

  if (!request.contentType || typeof request.contentType !== "string") {
    json(res, 400, {
      data: null,
      error: { code: "INVALID_REQUEST", message: "contentType is required and must be a string" },
    });
    return;
  }

  if (typeof request.fileSizeBytes !== "number" || request.fileSizeBytes < 0) {
    json(res, 400, {
      data: null,
      error: { code: "INVALID_REQUEST", message: "fileSizeBytes is required and must be a non-negative number" },
    });
    return;
  }

  if (!request.purpose || typeof request.purpose !== "string") {
    json(res, 400, {
      data: null,
      error: { code: "INVALID_REQUEST", message: "purpose is required and must be a string" },
    });
    return;
  }

  try {
    const response = await generatePresignedUrl(request);
    json(res, 201, {
      data: response,
      error: null,
    });
  } catch (err) {
    log.error("Failed to generate pre-signed URL", {
      error: err instanceof Error ? err.message : String(err),
    });

    if (err instanceof Error) {
      const error = err.message;

      // Handle validation errors
      if (error.includes("fileSizeBytes exceeds maximum")) {
        json(res, 400, {
          data: null,
          error: { code: "FILE_TOO_LARGE", message: error },
        });
        return;
      }

      if (error.includes("Invalid contentType")) {
        json(res, 400, {
          data: null,
          error: { code: "INVALID_CONTENT_TYPE", message: error },
        });
        return;
      }

      if (error.includes("filename cannot contain path separators")) {
        json(res, 400, {
          data: null,
          error: { code: "INVALID_FILENAME", message: error },
        });
        return;
      }
    }

    json(res, 500, {
      data: null,
      error: { code: "PRESIGNED_URL_FAILED", message: err instanceof Error ? err.message : "Failed to generate pre-signed URL" },
    });
  }
};

/**
 * Register storage routes.
 */
export function registerStorageRoutes(): Route[] {
  return [
    route("GET", "/api/v1/storage/status", storageStatusHandler),
    route("POST", "/api/v1/storage/presigned-url", generatePresignedUrlHandler),
  ];
}

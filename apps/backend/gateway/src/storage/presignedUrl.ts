/**
 * Pre-signed URL generation for S3/R2 uploads (Issue #112).
 *
 * Generates short-lived pre-signed URLs for direct client uploads to
 * Cloudflare R2 or AWS S3 with:
 * - 15-minute expiration
 * - Max file size limit (10MB)
 * - MIME type validation
 * - Purpose-based path organization
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("gateway:storage", process.env.LOG_LEVEL ?? "info");

// Configuration from environment
const BUCKET_NAME = process.env.STORAGE_BUCKET_NAME || "delego-uploads";
const REGION = process.env.STORAGE_REGION || "auto";
const ENDPOINT = process.env.STORAGE_ENDPOINT; // For Cloudflare R2 compatibility
const ACCESS_KEY_ID = process.env.STORAGE_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.STORAGE_SECRET_ACCESS_KEY;

// Max file size: 10MB
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

// Pre-signed URL expiration: 15 minutes
export const PRESIGNED_URL_EXPIRY_SECONDS = 15 * 60;

// Allowed content types
export const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

export type AllowedContentType = typeof ALLOWED_CONTENT_TYPES[number];

// Purpose types for path organization
export type UploadPurpose = "product_image" | "dispute_evidence";

/**
 * Request interface for pre-signed URL generation.
 */
export interface PresignedUrlRequest {
  filename: string;
  contentType: AllowedContentType;
  fileSizeBytes: number;
  purpose: UploadPurpose;
}

/**
 * Response interface containing pre-signed URL and public URL.
 */
export interface PresignedUrlResponse {
  uploadUrl: string;
  publicUrl: string;
  expiresInSeconds: number;
}

/**
 * Validate a pre-signed URL request.
 * Returns validation errors if any.
 */
export function validatePresignedUrlRequest(
  request: PresignedUrlRequest,
): { valid: true } | { valid: false; error: string } {
  // Validate filename
  if (!request.filename || typeof request.filename !== "string") {
    return { valid: false, error: "filename is required" };
  }

  // Check filename doesn't contain path traversal
  if (request.filename.includes("..") || request.filename.includes("/")) {
    return { valid: false, error: "filename cannot contain path separators" };
  }

  // Validate content type
  if (!ALLOWED_CONTENT_TYPES.includes(request.contentType as AllowedContentType)) {
    return { valid: false, error: `Invalid contentType. Must be one of: ${ALLOWED_CONTENT_TYPES.join(", ")}` };
  }

  // Validate file size (max 10MB)
  if (request.fileSizeBytes <= 0) {
    return { valid: false, error: "fileSizeBytes must be positive" };
  }
  if (request.fileSizeBytes > MAX_FILE_SIZE_BYTES) {
    return { valid: false, error: `fileSizeBytes exceeds maximum of ${MAX_FILE_SIZE_BYTES} bytes (10MB)` };
  }

  // Validate purpose
  if (!["product_image", "dispute_evidence"].includes(request.purpose)) {
    return { valid: false, error: "purpose must be 'product_image' or 'dispute_evidence'" };
  }

  return { valid: true };
}

/**
 * Validate a pre-signed URL request and throw on error.
 */
export function validatePresignedUrlRequestOrThrow(
  request: PresignedUrlRequest,
): void {
  const result = validatePresignedUrlRequest(request);
  if (!result.valid) {
    throw new Error(result.error);
  }
}

/**
 * Get S3 client with configured credentials.
 */
export function getS3Client(): S3Client {
  const config: Parameters<typeof S3Client>[0] = {
    region: REGION,
    credentials: {
      accessKeyId: ACCESS_KEY_ID || "dummy-access-key",
      secretAccessKey: SECRET_ACCESS_KEY || "dummy-secret-key",
    },
  };

  // Configure endpoint for Cloudflare R2 compatibility
  if (ENDPOINT) {
    config.endpoint = ENDPOINT;
    config.forcePathStyle = true;
  }

  return new S3Client(config);
}

/**
 * Generate a pre-signed URL for direct upload to S3/R2.
 */
export async function generatePresignedUrl(
  request: PresignedUrlRequest,
): Promise<PresignedUrlResponse> {
  validatePresignedUrlRequestOrThrow(request);

  const client = getS3Client();

  // Generate unique object key
  // Format: <purpose>/<timestamp>/<filename>
  const timestamp = Date.now();
  const objectKey = `${request.purpose}/${timestamp}/${request.filename}`;

  // Build the public URL
  // For Cloudflare R2: https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
  // For AWS S3: https://<bucket>.s3.<region>.amazonaws.com/<key>
  const publicUrl = getPublicUrl(objectKey);

  // Create PutObjectCommand with restrictions
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: objectKey,
    ContentType: request.contentType,
    ContentLength: request.fileSizeBytes,
  });

  // Generate pre-signed URL
  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
  });

  log.info("Generated pre-signed URL", {
    purpose: request.purpose,
    filename: request.filename,
    fileSizeBytes: request.fileSizeBytes,
    contentType: request.contentType,
    expiresInSeconds: PRESIGNED_URL_EXPIRY_SECONDS,
  });

  return {
    uploadUrl,
    publicUrl,
    expiresInSeconds: PRESIGNED_URL_EXPIRY_SECONDS,
  };
}

/**
 * Build the public URL for an uploaded object.
 */
export function getPublicUrl(objectKey: string): string {
  if (ENDPOINT) {
    // Cloudflare R2 format
    // Endpoint format: https://<account>.r2.cloudflarestorage.com
    const endpointUrl = new URL(ENDPOINT);
    return `${endpointUrl.protocol}//${endpointUrl.hostname}/${BUCKET_NAME}/${objectKey}`;
  }

  // AWS S3 format
  return `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com/${objectKey}`;
}

/**
 * Validate S3 configuration.
 */
export function checkStorageConfig(): {
  configured: boolean;
  missing?: string[];
} {
  const missing: string[] = [];

  if (!ACCESS_KEY_ID) missing.push("STORAGE_ACCESS_KEY_ID");
  if (!SECRET_ACCESS_KEY) missing.push("STORAGE_SECRET_ACCESS_KEY");
  if (!BUCKET_NAME || BUCKET_NAME === "delego-uploads") {
    // Check if it's still the default
    if (!process.env.STORAGE_BUCKET_NAME) missing.push("STORAGE_BUCKET_NAME");
  }

  return {
    configured: missing.length === 0,
    missing: missing.length > 0 ? missing : undefined,
  };
}

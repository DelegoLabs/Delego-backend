/**
 * Storage utilities for pre-signed URL generation (Issue #112).
 *
 * Provides short-lived pre-signed URLs for uploading product photos
 * and dispute evidence directly to Cloudflare R2 / AWS S3.
 */

export {
  generatePresignedUrl,
  validatePresignedUrlRequest,
  validatePresignedUrlRequestOrThrow,
} from "./presignedUrl.js";
export type { PresignedUrlRequest, PresignedUrlResponse } from "./presignedUrl.js";

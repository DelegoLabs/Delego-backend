/**
 * Compression Express Middleware Integration
 *
 * Provides Express-compatible compression middleware wrapper.
 */

import type { Request, Response, NextFunction } from "express";
import { CompressionMiddleware } from "./compression.js";
import type { CompressionConfig } from "./types.js";

export interface CompressionMiddlewareOptions {
  config?: CompressionConfig;
}

/**
 * Create an Express-compatible compression middleware.
 */
export function createCompressionMiddleware(
  options: CompressionMiddlewareOptions = {}
) {
  const compression = new CompressionMiddleware(options.config || {});

  return async (req: Request, res: Response, next: NextFunction) => {
    // Skip if no next function
    if (!next) return;

    // Store original methods
    const originalWriteHead = res.writeHead.bind(res);
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    let contentBuffer: Buffer[] = [];
    let contentType = "text/plain";
    let contentLength = 0;

    // Override writeHead to capture headers
    res.writeHead = function (status: number, headers?: Record<string, string | string[]>) {
      if (headers) {
        contentType = (headers["Content-Type"] || headers["content-type"] || "text/plain") as string;
      }
      return originalWriteHead(status, headers);
    };

    // Override write to buffer content
    res.write = function (chunk: any, encoding?: any) {
      if (chunk) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        contentBuffer.push(buf);
        contentLength += buf.length;
      }
      return true;
    };

    // Override end to compress and send
    res.end = async function (chunk?: any, encoding?: any) {
      if (chunk) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        contentBuffer.push(buf);
        contentLength += buf.length;
      }

      const fullBuffer = Buffer.concat(contentBuffer);

      // Check if compression should be applied
      if (
        fullBuffer.length >= compression["config"].minSizeBytes &&
        compression.isCompressible(contentType)
      ) {
        const acceptEncoding = req.headers["accept-encoding"] || "";
        const algorithm = compression.negotiateAlgorithm(acceptEncoding);

        if (compression["config"].algorithms.includes(algorithm as any)) {
          try {
            const result = await compression.compress(fullBuffer, contentType, algorithm);

            const headers: Record<string, string> = {
              "Content-Encoding": algorithm,
              "Vary": "Accept-Encoding",
            };

            if (result.fromCache) {
              headers["X-Compression-Cache"] = "HIT";
            } else {
              headers["X-Compression-Cache"] = "MISS";
            }

            originalWriteHead.call(res, 200, headers);
            originalEnd.call(res, result);
          } catch {
            // Compression failed, send uncompressed
            originalWriteHead.call(res, 200, { "Content-Type": contentType });
            originalEnd.call(res, fullBuffer);
          }
          return;
        }
      }

      // Send uncompressed
      originalWriteHead.call(res, 200, { "Content-Type": contentType });
      originalEnd.call(res, fullBuffer);
    };

    next();
  };
}

/**
 * Get compression metrics from Express middleware.
 */
export function getCompressionMetrics(compression: CompressionMiddleware) {
  return compression.getMetrics();
}

/**
 * Clear compression cache from Express middleware.
 */
export function clearCompressionCache(compression: CompressionMiddleware) {
  compression.clearCache();
}

// Export types
export type { CompressionConfig };
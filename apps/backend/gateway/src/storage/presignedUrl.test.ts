import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  validatePresignedUrlRequest,
  validatePresignedUrlRequestOrThrow,
  MAX_FILE_SIZE_BYTES,
  ALLOWED_CONTENT_TYPES,
} from "./presignedUrl.js";

describe("validatePresignedUrlRequest", () => {
  it("validates a correct request", () => {
    const request = {
      filename: "product.jpg",
      contentType: "image/jpeg",
      fileSizeBytes: 1024 * 1024, // 1MB
      purpose: "product_image",
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(true);
  });

  it("rejects missing filename", () => {
    const request = {
      filename: "",
      contentType: "image/jpeg",
      fileSizeBytes: 1024,
      purpose: "product_image",
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("filename is required");
  });

  it("rejects filename with path traversal", () => {
    const request = {
      filename: "../etc/passwd",
      contentType: "image/jpeg",
      fileSizeBytes: 1024,
      purpose: "product_image",
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("filename cannot contain path separators");
  });

  it("rejects filename with path separator", () => {
    const request = {
      filename: "images/product.jpg",
      contentType: "image/jpeg",
      fileSizeBytes: 1024,
      purpose: "product_image",
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("filename cannot contain path separators");
  });

  it("rejects invalid content type", () => {
    const request = {
      filename: "product.exe",
      contentType: "application/exe" as any,
      fileSizeBytes: 1024,
      purpose: "product_image",
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toBe(`Invalid contentType. Must be one of: ${ALLOWED_CONTENT_TYPES.join(", ")}`);
  });

  it("rejects zero file size", () => {
    const request = {
      filename: "product.jpg",
      contentType: "image/jpeg",
      fileSizeBytes: 0,
      purpose: "product_image",
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("fileSizeBytes must be positive");
  });

  it("rejects negative file size", () => {
    const request = {
      filename: "product.jpg",
      contentType: "image/jpeg",
      fileSizeBytes: -100,
      purpose: "product_image",
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("fileSizeBytes must be positive");
  });

  it("rejects file size exceeding 10MB", () => {
    const request = {
      filename: "product.jpg",
      contentType: "image/jpeg",
      fileSizeBytes: MAX_FILE_SIZE_BYTES + 1,
      purpose: "product_image",
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toBe(`fileSizeBytes exceeds maximum of ${MAX_FILE_SIZE_BYTES} bytes (10MB)`);
  });

  it("rejects invalid purpose", () => {
    const request = {
      filename: "product.jpg",
      contentType: "image/jpeg",
      fileSizeBytes: 1024,
      purpose: "invalid_purpose" as any,
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("purpose must be 'product_image' or 'dispute_evidence'");
  });

  it("accepts dispute_evidence purpose", () => {
    const request = {
      filename: "evidence.pdf",
      contentType: "application/pdf",
      fileSizeBytes: 1024 * 1024,
      purpose: "dispute_evidence",
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(true);
  });

  it("accepts all allowed content types", () => {
    const contentTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;

    for (const contentType of contentTypes) {
      const request = {
        filename: `file.${contentType.split("/")[1]}`,
        contentType,
        fileSizeBytes: 1024,
        purpose: "product_image",
      };

      const result = validatePresignedUrlRequest(request);
      expect(result.valid).toBe(true);
    }
  });
});

describe("validatePresignedUrlRequestOrThrow", () => {
  it("does not throw for valid request", () => {
    const request = {
      filename: "product.jpg",
      contentType: "image/jpeg",
      fileSizeBytes: 1024,
      purpose: "product_image",
    };

    expect(() => validatePresignedUrlRequestOrThrow(request)).not.toThrow();
  });

  it("throws for invalid filename", () => {
    const request = {
      filename: "",
      contentType: "image/jpeg",
      fileSizeBytes: 1024,
      purpose: "product_image",
    };

    expect(() => validatePresignedUrlRequestOrThrow(request)).toThrow("filename is required");
  });
});

describe("MAX_FILE_SIZE_BYTES", () => {
  it("should be 10MB", () => {
    expect(MAX_FILE_SIZE_BYTES).toBe(10 * 1024 * 1024);
  });
});

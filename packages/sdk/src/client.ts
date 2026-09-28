import type { ApiResponse, Escrow, HealthCheckResponse } from "@delegolabs/types";
import { z } from "zod";
import {
  ApiResponseSchema,
  DelegationSchema,
  HealthCheckResponseSchema,
  OrderSchema,
  validateResponse,
} from "./schemas.js";
import { scrubExifMetadataIfNeeded } from "./exifScrubber.js";

export interface DelegoClientOptions {
  baseUrl: string;
  /** Bearer token for authenticated requests */
  token?: string;
  /** Timeout in milliseconds for requests (default: 30000) */
  timeout?: number;
  /**
   * Called whenever a request receives a 401 response. The stored token is
   * cleared before this fires, so callers should redirect to login here.
   */
  onUnauthorized?: () => void;
  /** Storage to persist the token in across page reloads (default: localStorage). */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

const TOKEN_STORAGE_KEY = "delego_auth_token";

/** Result of a dispute-evidence upload after metadata scrubbing. */
export interface DisputeEvidenceUpload {
  /** Public URL of the scrubbed object stored in R2/S3. */
  publicUrl: string;
  /** MIME type of the uploaded (scrubbed) object. */
  contentType: string;
  /** Size of the uploaded (scrubbed) object in bytes. */
  sizeBytes: number;
}

export interface UploadDisputeEvidenceOptions {
  /** Filename to store the evidence under. Defaults to the File's name. */
  filename?: string;
  /** Abort signal forwarded to the pre-sign request and the upload PUT. */
  signal?: AbortSignal;
}

const EVIDENCE_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
};

/** Collapse a user-supplied name to a safe basename (no separators or ".."). */
function sanitizeEvidenceFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/\.\./g, "").replace(/[^\w.\- ]+/g, "_").trim();
  return cleaned || "evidence";
}

/** Resolve the content type from the extension, falling back to the Blob's. */
function resolveEvidenceContentType(filename: string, fallback: string): string {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return EVIDENCE_CONTENT_TYPES[extension] ?? fallback;
}

function getDefaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined {
  if (typeof window === "undefined" || !window.localStorage) return undefined;
  return window.localStorage;
}

export class TimeoutError extends Error {
  constructor(message = "Request timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function getCsrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(/csrf-token=([^;]+)/);
  return match?.[1];
}

  /**
 * HTTP client for the Delego API Gateway.
 */
export class DelegoClient {
  private readonly baseUrl: string;
  private token?: string;
  private readonly timeout: number;
  private readonly onUnauthorized?: () => void;
  private readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;

  constructor(options: DelegoClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.timeout = options.timeout ?? 30000;
    this.onUnauthorized = options.onUnauthorized;
    this.storage = options.storage ?? getDefaultStorage();
    this.token = options.token ?? this.storage?.getItem(TOKEN_STORAGE_KEY) ?? undefined;
  }

  /** Store the auth token in memory and persist it (localStorage by default). */
  setToken(token: string): void {
    this.token = token;
    this.storage?.setItem(TOKEN_STORAGE_KEY, token);
  }

  /** Return the current auth token, or null if none is set. */
  getToken(): string | null {
    return this.token ?? null;
  }

  /** Clear the auth token from memory and persisted storage (e.g. on logout). */
  clearToken(): void {
    this.token = undefined;
    this.storage?.removeItem(TOKEN_STORAGE_KEY);
  }

  private async request<T>(
    path: string,
    init?: RequestInit & { timeout?: number; signal?: AbortSignal },
    dataSchema?: import("zod").ZodType<unknown>
  ): Promise<ApiResponse<T>> {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string>),
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (STATE_CHANGING_METHODS.has(method)) {
      const csrfToken = getCsrfToken();
      if (csrfToken) {
        headers["X-CSRF-Token"] = csrfToken;
      }
    }

    const controller = new AbortController();
    const timeoutMs = init?.timeout ?? this.timeout;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const externalSignal = init?.signal;
    let onExternalAbort: (() => void) | undefined;
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timer);
        throw new DOMException("The operation was aborted", "AbortError");
      }
      onExternalAbort = () => controller.abort();
      externalSignal.addEventListener("abort", onExternalAbort, {
        once: true,
      });
    }

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers,
      });

      clearTimeout(timer);
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }

      if (response.status === 401) {
        this.clearToken();
        this.onUnauthorized?.();
      }

      const rawData = await response.json();
      if (dataSchema) {
        const schema = ApiResponseSchema(dataSchema);
        return validateResponse(rawData, schema) as ApiResponse<T>;
      }
      return rawData as ApiResponse<T>;
    } catch (error) {
      clearTimeout(timer);
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
      if (
        error instanceof DOMException &&
        error.name === "AbortError" &&
        controller.signal.aborted
      ) {
        if (externalSignal?.aborted) {
          throw new DOMException("The operation was aborted", "AbortError");
        }
        throw new TimeoutError();
      }
      throw error;
    }
  }

  async health(): Promise<ApiResponse<HealthCheckResponse>> {
    return this.request<HealthCheckResponse>(
      "/health",
      undefined,
      HealthCheckResponseSchema
    );
  }

  async getDelegations(
    options?: { signal?: AbortSignal }
  ): Promise<ApiResponse<import("@delegolabs/types").Delegation[]>> {
    return this.request<import("@delegolabs/types").Delegation[]>(
      "/api/v1/delegations",
      { signal: options?.signal },
      z.array(DelegationSchema)
    );
  }

  async getOrders(
    options?: { signal?: AbortSignal }
  ): Promise<ApiResponse<import("@delegolabs/types").Order[]>> {
    return this.request<import("@delegolabs/types").Order[]>(
      "/api/v1/orders",
      { signal: options?.signal },
      z.array(OrderSchema)
    );
  }

  /** Approve a high-value order awaiting manual review. */
  async approveOrder(
    id: string
  ): Promise<ApiResponse<import("@delegolabs/types").Order>> {
    return this.request<import("@delegolabs/types").Order>(
      `/api/v1/orders/${encodeURIComponent(id)}/approve`,
      { method: "POST" },
      OrderSchema
    );
  }

  /** Reject a high-value order awaiting manual review, with an optional reason. */
  async rejectOrder(
    id: string,
    reason?: string
  ): Promise<ApiResponse<import("@delegolabs/types").Order>> {
    return this.request<import("@delegolabs/types").Order>(
      `/api/v1/orders/${encodeURIComponent(id)}/reject`,
      { method: "POST", body: JSON.stringify({ reason: reason ?? null }) },
      OrderSchema
    );
  }

  async getOrder(
    id: string
  ): Promise<ApiResponse<import("@delegolabs/types").Order>> {
    return this.request<import("@delegolabs/types").Order>(
      `/api/v1/orders/${encodeURIComponent(id)}`,
      undefined,
      OrderSchema
    );
  }

  /** Cancel an order. */
  async cancelOrder(
    id: string
  ): Promise<ApiResponse<import("@delegolabs/types").Order>> {
    return this.request<import("@delegolabs/types").Order>(
      `/api/v1/orders/${encodeURIComponent(id)}/cancel`,
      { method: "POST" },
      OrderSchema
    );
  }

  /** Get the status of an order. */
  async getOrderStatus(
    id: string
  ): Promise<ApiResponse<{ status: string }>> {
    return this.request<{ status: string }>(
      `/api/v1/orders/${encodeURIComponent(id)}/status`,
      undefined
    );
  }

  async createDelegation(
    input: import("@delegolabs/types").CreateDelegationInput
  ): Promise<ApiResponse<import("@delegolabs/types").Delegation>> {
    return this.request<import("@delegolabs/types").Delegation>(
      "/api/v1/delegations",
      { method: "POST", body: JSON.stringify(input) },
      DelegationSchema
    );
  }

  async updateDelegation(
    id: string,
    input: import("@delegolabs/types").UpdateDelegationInput
  ): Promise<ApiResponse<import("@delegolabs/types").Delegation>> {
    return this.request<import("@delegolabs/types").Delegation>(
      `/api/v1/delegations/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(input) },
      DelegationSchema
    );
  }

  async revokeDelegation(
    id: string
  ): Promise<ApiResponse<{ id: string; status: string }>> {
    return this.request<{ id: string; status: string }>(
      `/api/v1/delegations/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
  }

  async getEscrows(): Promise<ApiResponse<Escrow[]>> {
    return this.request<Escrow[]>("/api/v1/escrows");
  }

  /**
   * Strip EXIF metadata (GPS coordinates, camera serial numbers, …) from a
   * photo in the browser, then upload it as dispute evidence (#789):
   *
   * 1. Re-render to a canvas at the original resolution to drop EXIF.
   * 2. Request a pre-signed upload URL (`purpose: "dispute_evidence"`).
   * 3. PUT the scrubbed bytes directly to storage.
   *
   * Non-image evidence (e.g. PDFs) is passed through untouched.
   */
  async uploadDisputeEvidence(
    file: File,
    options: UploadDisputeEvidenceOptions = {},
  ): Promise<ApiResponse<DisputeEvidenceUpload>> {
    const filename = sanitizeEvidenceFilename(options.filename ?? file.name ?? "evidence");
    const scrubbed = await scrubExifMetadataIfNeeded(file);
    const contentType = resolveEvidenceContentType(filename, scrubbed.type || file.type);

    const presign = await this.request<{
      uploadUrl: string;
      publicUrl: string;
      expiresInSeconds: number;
    }>("/api/v1/storage/presigned-url", {
      method: "POST",
      body: JSON.stringify({
        filename,
        contentType,
        fileSizeBytes: scrubbed.size,
        purpose: "dispute_evidence",
      }),
      signal: options.signal,
    });

    if (presign.error || !presign.data) {
      return {
        data: null,
        error: presign.error ?? {
          code: "PRESIGNED_URL_FAILED",
          message: "No upload URL was returned",
        },
      };
    }

    const upload = await fetch(presign.data.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: scrubbed,
      signal: options.signal,
    });

    if (!upload.ok) {
      return {
        data: null,
        error: {
          code: "EVIDENCE_UPLOAD_FAILED",
          message: `Evidence upload failed with status ${upload.status}`,
        },
      };
    }

    return {
      data: {
        publicUrl: presign.data.publicUrl,
        contentType,
        sizeBytes: scrubbed.size,
      },
      error: null,
    };
  }
}

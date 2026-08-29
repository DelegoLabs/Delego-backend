/**
 * Request/Response Logging with PII Masking
 * Issue #151
 */

export interface LoggingConfig {
  enabled: boolean;
  sampleRate: number;
  piiFields: string[];
  maskingRules: Array<{
    pattern: string;
    replacement: string;
  }>;
  sensitiveEndpoints: string[];
  retentionDays: number;
}

export interface LogEntry {
  requestId: string;
  timestamp: string;
  method: string;
  path: string;
  requestHeaders: Record<string, string>;
  requestBody: Record<string, unknown>;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: Record<string, unknown>;
  durationMs: number;
  userId?: string;
  piiMasked: boolean;
}

export interface LogSearchQuery {
  userId?: string;
  path?: string;
  method?: string;
  statusCode?: number;
  startTime: string;
  endTime: string;
  limit: number;
  includeMasked: boolean;
}

export interface MaskingResult {
  masked: Record<string, unknown>;
  fieldsMasked: string[];
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  userId: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
}

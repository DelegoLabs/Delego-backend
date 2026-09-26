/**
 * Base64 cursor encoding/decoding utilities for deterministic pagination.
 *
 * Cursor format: base64("created_at|id") where:
 * - created_at: ISO 8601 timestamp string
 * - id: unique identifier string
 *
 * This provides stable pagination on (created_at, id) tuples to prevent
 * duplicates/misses during page navigation.
 */

/**
 * Encode a string to Base64.
 */
export function toBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/**
 * Decode a Base64 string to plain text.
 */
export function fromBase64(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf8");
}

/**
 * Encode pagination cursor from (created_at, id) tuple.
 * Format: base64("created_at|id")
 */
export function encodeCursor(createdAt: string, id: string): string {
  return toBase64(`${createdAt}|${id}`);
}

/**
 * Decode Base64 cursor to (created_at, id) tuple.
 * Returns null if decoding fails.
 */
export function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const decoded = fromBase64(cursor);
    const pipeIndex = decoded.indexOf("|");
    if (pipeIndex === -1) return null;
    
    const createdAt = decoded.substring(0, pipeIndex);
    const id = decoded.substring(pipeIndex + 1);
    
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Validate cursor format (Base64 string).
 */
export function isValidCursor(cursor: string): boolean {
  const cursorPattern = /^[A-Za-z0-9+/]{4,}={0,2}$/;
  if (!cursorPattern.test(cursor)) return false;
  
  try {
    fromBase64(cursor);
    return true;
  } catch {
    return false;
  }
}

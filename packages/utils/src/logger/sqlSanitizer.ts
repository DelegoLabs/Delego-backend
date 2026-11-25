/**
 * Automated secret-scanning validator for database query logging (Issue #616).
 *
 * Debug logs for database queries can accidentally leak decrypted private
 * keys, BIP-39 mnemonic seeds, or user passwords into log aggregation
 * systems (Datadog, CloudWatch) in two ways:
 *
 *  1. The value is bound as a parameterized query argument (`$1`, `?`) whose
 *     *column* is known to carry sensitive data (e.g. `password`, `secret`,
 *     `private_key`, `mnemonic`) — the column name is read off the SQL text
 *     itself (INSERT column list / UPDATE SET / WHERE equality) so the
 *     corresponding positional parameter can be redacted regardless of its
 *     shape.
 *  2. The secret is embedded directly in a string value (parameterized or
 *     not) that matches a known secret shape — a Stellar secret key
 *     (`S[A-Z0-9]{55}`), a JWT (`xxx.yyy.zzz` base64url segments), or a
 *     bcrypt/argon2 password hash — regardless of which column it came from.
 *
 * `sanitize()` is pure and synchronous so it can be called inline from a
 * Sequelize/pg query logger without adding I/O latency to the query path.
 */

export interface QueryLogSanitizer {
  sanitize: (
    sqlQuery: string,
    params: unknown[],
  ) => {
    safeQuery: string;
    safeParams: unknown[];
  };
}

export const REDACTED_SECRET_PLACEHOLDER = "[REDACTED_SECRET]";

/** Stellar secret seed: "S" followed by 55 base32 chars (56 chars total). */
const STELLAR_SECRET_PATTERN = /\bS[A-Z0-9]{55}\b/g;

/** JWT: three dot-separated base64url segments, header always starts `eyJ`. */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

/** bcrypt ($2a$/$2b$/$2y$) and argon2 ($argon2i$/$argon2id$) password hashes. */
const PASSWORD_HASH_PATTERN = /\$2[aby]\$\d{2}\$[A-Za-z0-9./]{53}|\$argon2(?:i|id|d)\$[A-Za-z0-9+/.$=]+/g;

/** Combined shape-based patterns, checked against every string value seen. */
const SECRET_SHAPE_PATTERNS = [STELLAR_SECRET_PATTERN, JWT_PATTERN, PASSWORD_HASH_PATTERN];

/** Column-name fragments that always carry sensitive data, wherever they appear. */
const SENSITIVE_COLUMN_PATTERN =
  /(password|passwd|secret|private_?key|priv_?key|mnemonic|seed_?phrase|api_?key|access_?token|refresh_?token)/i;

function redactSecretShapes(value: string): { value: string; redacted: boolean } {
  let redacted = false;
  let out = value;
  for (const pattern of SECRET_SHAPE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(out)) {
      redacted = true;
    }
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED_SECRET_PLACEHOLDER);
  }
  return { value: out, redacted };
}

/**
 * Maps 1-based positional placeholder index -> column name, by reading the
 * column list out of `INSERT ... (cols) VALUES (...)`, `UPDATE ... SET col =
 * $n`, and `WHERE col = $n` clauses. Supports both Postgres-style `$1`/`$2`
 * and ordinal `?` placeholders (resolved to their index of occurrence).
 */
function mapPlaceholdersToColumns(sqlQuery: string): Map<number, string> {
  const columnByIndex = new Map<number, string>();

  // INSERT INTO table (a, b, c) VALUES ($1, $2, $3)
  const insertMatch = sqlQuery.match(
    /INSERT\s+INTO\s+[\w."]+\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
  );
  if (insertMatch) {
    const columns = insertMatch[1].split(",").map((c) => c.trim().replace(/["`]/g, ""));
    const placeholders = insertMatch[2].split(",").map((p) => p.trim());
    placeholders.forEach((placeholder, i) => {
      const idx = resolvePlaceholderIndex(placeholder, i);
      if (idx !== undefined && columns[i]) {
        columnByIndex.set(idx, columns[i]);
      }
    });
  }

  // UPDATE table SET a = $1, b = $2 [WHERE ...]
  const setClauseMatch = sqlQuery.match(/UPDATE\s+[\w."]+\s+SET\s+([\s\S]+?)(?:\s+WHERE\b|$)/i);
  if (setClauseMatch) {
    for (const assignment of splitTopLevelCommas(setClauseMatch[1])) {
      const assignMatch = assignment.match(/([\w"`]+)\s*=\s*(\$\d+|\?)/);
      if (assignMatch) {
        const idx = resolvePlaceholderIndex(assignMatch[2], 0);
        if (idx !== undefined) {
          columnByIndex.set(idx, assignMatch[1].replace(/["`]/g, ""));
        }
      }
    }
  }

  // Any `col = $n` / `col = ?` equality anywhere else (e.g. WHERE clauses).
  const equalityPattern = /([\w"`]+)\s*=\s*(\$\d+|\?)/g;
  let match: RegExpExecArray | null;
  let ordinalCount = 0;
  while ((match = equalityPattern.exec(sqlQuery)) !== null) {
    const idx = resolvePlaceholderIndex(match[2], ordinalCount);
    if (match[2] === "?") ordinalCount++;
    if (idx !== undefined && !columnByIndex.has(idx)) {
      columnByIndex.set(idx, match[1].replace(/["`]/g, ""));
    }
  }

  return columnByIndex;
}

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of input) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Resolves a `$n` placeholder to its 1-based index, or a `?` to `fallbackOrdinal + 1`. */
function resolvePlaceholderIndex(placeholder: string, fallbackOrdinal: number): number | undefined {
  const dollarMatch = placeholder.match(/^\$(\d+)$/);
  if (dollarMatch) {
    return Number(dollarMatch[1]);
  }
  if (placeholder === "?") {
    return fallbackOrdinal + 1;
  }
  return undefined;
}

/**
 * Default `QueryLogSanitizer`. Redacts:
 *  - any parameter bound to a column whose name matches
 *    {@link SENSITIVE_COLUMN_PATTERN}, no matter what the value looks like;
 *  - any string value (parameter or literal inlined in the query text) whose
 *    *content* matches a known secret shape (Stellar secret, JWT, password
 *    hash), regardless of its column.
 */
export const defaultQueryLogSanitizer: QueryLogSanitizer = {
  sanitize(sqlQuery: string, params: unknown[]) {
    const columnByIndex = mapPlaceholdersToColumns(sqlQuery);

    const safeParams = params.map((param, i) => {
      const placeholderIndex = i + 1;
      const column = columnByIndex.get(placeholderIndex);
      if (column && SENSITIVE_COLUMN_PATTERN.test(column)) {
        return REDACTED_SECRET_PLACEHOLDER;
      }
      if (typeof param === "string") {
        return redactSecretShapes(param).value;
      }
      return param;
    });

    let safeQuery = sqlQuery;
    for (const pattern of SECRET_SHAPE_PATTERNS) {
      pattern.lastIndex = 0;
      safeQuery = safeQuery.replace(pattern, REDACTED_SECRET_PLACEHOLDER);
    }

    return { safeQuery, safeParams };
  },
};

/**
 * Builds a Sequelize-compatible `logging` function that sanitizes the SQL
 * text before handing it to `sink` (e.g. a pino/winston logger's `.debug`).
 * Sequelize's default logging callback only receives the final SQL string
 * (with bind parameters already interpolated for display), so this also
 * strips any secret shape that may have been interpolated into the text
 * itself — the `params` branch of `sanitize()` matters for callers (raw `pg`
 * query interceptors) that log parameterized SQL and bind params separately.
 */
export function createSanitizingQueryLogger(
  sink: (message: string) => void,
  sanitizer: QueryLogSanitizer = defaultQueryLogSanitizer,
): (sqlQuery: string, params?: unknown[]) => void {
  return (sqlQuery: string, params: unknown[] = []) => {
    const { safeQuery } = sanitizer.sanitize(sqlQuery, params);
    sink(safeQuery);
  };
}

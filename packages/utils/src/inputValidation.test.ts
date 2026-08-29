import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  isPathTraversalSafe,
  validateSection,
  validateRequest,
  type ValidationRule,
} from "./inputValidation.js";

describe("escapeHtml", () => {
  it("escapes the 5 HTML-significant characters", () => {
    expect(escapeHtml(`<script>alert('x')</script> & "quoted"`)).toBe(
      "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;quoted&quot;",
    );
  });

  it("leaves plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("isPathTraversalSafe", () => {
  it("rejects a relative traversal segment", () => {
    expect(isPathTraversalSafe("../../etc/passwd")).toBe(false);
  });

  it("rejects an absolute path", () => {
    expect(isPathTraversalSafe("/etc/passwd")).toBe(false);
  });

  it("allows a plain filename", () => {
    expect(isPathTraversalSafe("invoice.pdf")).toBe(true);
  });
});

describe("validateSection — required and type checks", () => {
  const rules: ValidationRule[] = [
    { field: "name", type: "string", required: true },
    { field: "age", type: "number", required: false },
  ];

  it("fails when a required field is missing", () => {
    const result = validateSection(rules, {});
    expect(result.valid).toBe(false);
    expect(result.errors[0].rule).toBe("required");
  });

  it("passes when a non-required field is omitted", () => {
    const result = validateSection(rules, { name: "Alice" });
    expect(result.valid).toBe(true);
  });

  it("fails on a type mismatch", () => {
    const result = validateSection(rules, { name: "Alice", age: "not-a-number" });
    expect(result.valid).toBe(false);
    expect(result.errors[0].rule).toBe("type");
  });
});

describe("validateSection — string constraints", () => {
  it("fails a string shorter than minLength", () => {
    const rules: ValidationRule[] = [{ field: "x", type: "string", required: true, minLength: 5 }];
    expect(validateSection(rules, { x: "ab" }).valid).toBe(false);
  });

  it("fails a string longer than maxLength", () => {
    const rules: ValidationRule[] = [{ field: "x", type: "string", required: true, maxLength: 3 }];
    expect(validateSection(rules, { x: "abcdef" }).valid).toBe(false);
  });

  it("fails a string that doesn't match a pattern", () => {
    const rules: ValidationRule[] = [{ field: "x", type: "string", required: true, pattern: "^[a-z]+$" }];
    expect(validateSection(rules, { x: "ABC123" }).valid).toBe(false);
    expect(validateSection(rules, { x: "abc" }).valid).toBe(true);
  });

  it("fails a value not in the enum list", () => {
    const rules: ValidationRule[] = [{ field: "x", type: "string", required: true, enum: ["a", "b"] }];
    expect(validateSection(rules, { x: "c" }).valid).toBe(false);
    expect(validateSection(rules, { x: "a" }).valid).toBe(true);
  });
});

describe("validateSection — typed field formats", () => {
  it("validates email format", () => {
    const rules: ValidationRule[] = [{ field: "e", type: "email", required: true }];
    expect(validateSection(rules, { e: "not-an-email" }).valid).toBe(false);
    expect(validateSection(rules, { e: "a@b.com" }).valid).toBe(true);
  });

  it("validates URL format", () => {
    const rules: ValidationRule[] = [{ field: "u", type: "url", required: true }];
    expect(validateSection(rules, { u: "not a url" }).valid).toBe(false);
    expect(validateSection(rules, { u: "https://example.com" }).valid).toBe(true);
  });

  it("validates UUID format", () => {
    const rules: ValidationRule[] = [{ field: "id", type: "uuid", required: true }];
    expect(validateSection(rules, { id: "not-a-uuid" }).valid).toBe(false);
    expect(validateSection(rules, { id: "123e4567-e89b-12d3-a456-426614174000" }).valid).toBe(true);
  });

  it("validates date format", () => {
    const rules: ValidationRule[] = [{ field: "d", type: "date", required: true }];
    expect(validateSection(rules, { d: "not-a-date" }).valid).toBe(false);
    expect(validateSection(rules, { d: "2026-01-01" }).valid).toBe(true);
  });
});

describe("validateSection — custom validator and sanitizer", () => {
  it("runs a customValidator and fails when it returns false", () => {
    const rules: ValidationRule[] = [
      { field: "x", type: "custom", required: true, customValidator: (v) => v === "expected" },
    ];
    expect(validateSection(rules, { x: "unexpected" }).valid).toBe(false);
    expect(validateSection(rules, { x: "expected" }).valid).toBe(true);
  });

  it("applies a sanitizer to the sanitizedData output", () => {
    const rules: ValidationRule[] = [
      { field: "bio", type: "string", required: true, sanitizer: escapeHtml },
    ];
    const result = validateSection(rules, { bio: "<b>hi</b>" });
    expect(result.sanitizedData.bio).toBe("&lt;b&gt;hi&lt;/b&gt;");
  });
});

describe("validateRequest — merges sections", () => {
  it("validates body, query, and params together and aggregates errors", () => {
    const result = validateRequest(
      {
        body: [{ field: "name", type: "string", required: true }],
        query: [{ field: "page", type: "number", required: true }],
        params: [{ field: "id", type: "uuid", required: true }],
      },
      { body: {}, query: { page: "not-a-number" }, params: { id: "bad-uuid" } },
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(3);
  });

  it("passes when every section is valid", () => {
    const result = validateRequest(
      {
        body: [{ field: "name", type: "string", required: true }],
        params: [{ field: "id", type: "uuid", required: true }],
      },
      { body: { name: "Alice" }, params: { id: "123e4567-e89b-12d3-a456-426614174000" } },
    );
    expect(result.valid).toBe(true);
  });

  it("skips a section entirely when the schema doesn't declare rules for it", () => {
    const result = validateRequest({ body: [{ field: "name", type: "string", required: true }] }, {
      body: { name: "Alice" },
      query: { anything: "goes" },
    });
    expect(result.valid).toBe(true);
  });
});

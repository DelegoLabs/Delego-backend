import { describe, it, expect } from "vitest";
import {
  detectSuspiciousPatterns,
  buildSecurityEvents,
  validateFileUpload,
} from "./securityEventDetection.js";

describe("detectSuspiciousPatterns", () => {
  it("returns an empty array for benign input", () => {
    expect(detectSuspiciousPatterns("hello world")).toEqual([]);
  });

  it("detects an XSS script tag", () => {
    expect(detectSuspiciousPatterns("<script>alert(1)</script>")).toContain("xss_attempt");
  });

  it("detects an inline event handler XSS payload", () => {
    expect(detectSuspiciousPatterns(`<img src=x onerror="alert(1)">`)).toContain("xss_attempt");
  });

  it("detects a UNION SELECT SQL injection payload", () => {
    expect(detectSuspiciousPatterns("1 UNION SELECT username, password FROM users")).toContain(
      "sql_injection",
    );
  });

  it("detects a classic OR 1=1 SQL injection payload", () => {
    expect(detectSuspiciousPatterns("admin' OR 1=1--")).toContain("sql_injection");
  });

  it("detects a DROP TABLE payload", () => {
    expect(detectSuspiciousPatterns("x; DROP TABLE users")).toContain("sql_injection");
  });

  it("detects path traversal", () => {
    expect(detectSuspiciousPatterns("../../etc/passwd")).toContain("path_traversal");
  });

  it("detects command injection via shell metacharacters", () => {
    expect(detectSuspiciousPatterns("file.txt; rm -rf /")).toContain("command_injection");
  });

  it("detects command substitution syntax", () => {
    expect(detectSuspiciousPatterns("$(cat /etc/passwd)")).toContain("command_injection");
  });

  it("can detect multiple categories in a single payload", () => {
    const matches = detectSuspiciousPatterns("<script>x</script>; rm -rf /");
    expect(matches).toContain("xss_attempt");
    expect(matches).toContain("command_injection");
  });
});

describe("buildSecurityEvents", () => {
  it("returns no events for benign input", () => {
    const events = buildSecurityEvents("hello", { sourceIp: "1.2.3.4", endpoint: "/api/x", blocked: true });
    expect(events).toEqual([]);
  });

  it("builds a critical-severity event for SQL injection", () => {
    const events = buildSecurityEvents("' OR 1=1--", {
      sourceIp: "1.2.3.4",
      endpoint: "/api/login",
      blocked: true,
    });
    const sqlEvent = events.find((e) => e.type === "sql_injection");
    expect(sqlEvent?.severity).toBe("critical");
    expect(sqlEvent?.sourceIp).toBe("1.2.3.4");
    expect(sqlEvent?.endpoint).toBe("/api/login");
    expect(sqlEvent?.blocked).toBe(true);
  });

  it("builds a medium-severity event for XSS", () => {
    const events = buildSecurityEvents("<script>x</script>", {
      sourceIp: "1.2.3.4",
      endpoint: "/api/comments",
      blocked: false,
    });
    expect(events[0].severity).toBe("medium");
    expect(events[0].blocked).toBe(false);
  });

  it("uses the injected clock for the timestamp", () => {
    const events = buildSecurityEvents(
      "<script>x</script>",
      { sourceIp: "1.2.3.4", endpoint: "/x", blocked: true },
      () => "2026-01-01T00:00:00.000Z",
    );
    expect(events[0].timestamp).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("validateFileUpload", () => {
  it("passes a valid PDF upload with matching magic number", () => {
    const result = validateFileUpload({
      filename: "invoice.pdf",
      sizeBytes: 1024,
      declaredMimeType: "application/pdf",
      headerBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a disallowed file extension", () => {
    const result = validateFileUpload({ filename: "script.exe", sizeBytes: 1024, declaredMimeType: "application/octet-stream" });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/not allowed/);
  });

  it("rejects a file exceeding the max size", () => {
    const result = validateFileUpload({
      filename: "big.png",
      sizeBytes: 20 * 1024 * 1024,
      declaredMimeType: "image/png",
    });
    expect(result.valid).toBe(false);
  });

  it("rejects an empty file", () => {
    const result = validateFileUpload({ filename: "empty.png", sizeBytes: 0, declaredMimeType: "image/png" });
    expect(result.valid).toBe(false);
  });

  it("rejects a file whose content doesn't match its declared MIME type", () => {
    // Declares PNG but the header bytes are actually a JPEG's magic number.
    const result = validateFileUpload({
      filename: "fake.png",
      sizeBytes: 1024,
      declaredMimeType: "image/png",
      headerBytes: new Uint8Array([0xff, 0xd8, 0xff]),
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/does not match declared type/);
  });

  it("skips the magic-number check when no header bytes are provided", () => {
    const result = validateFileUpload({ filename: "photo.jpg", sizeBytes: 1024, declaredMimeType: "image/jpeg" });
    expect(result.valid).toBe(true);
  });
});

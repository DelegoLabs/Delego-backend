import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSanitizedJson,
  prototypeSanitizingReviver,
  PrototypePollutionError,
  PayloadTooLargeError,
  DEFAULT_JSON_SIZE_LIMIT_BYTES,
  UPLOAD_JSON_SIZE_LIMIT_BYTES,
} from "./jsonSanitizer.ts";

describe("jsonSanitizer - Issue #615", () => {
  it("rejects payloads with __proto__ key", () => {
    const malicious = '{"username": "alice", "__proto__": {"isAdmin": true}}';
    assert.throws(
      () => parseSanitizedJson(malicious),
      (err: any) => err instanceof PrototypePollutionError && err.statusCode === 400
    );
  });

  it("rejects payloads with constructor key", () => {
    const malicious = '{"constructor": {"prototype": {"polluted": true}}}';
    assert.throws(
      () => parseSanitizedJson(malicious),
      (err: any) => err instanceof PrototypePollutionError && err.statusCode === 400
    );
  });

  it("rejects payloads with prototype key", () => {
    const malicious = '{"target": {"prototype": "bad"}}';
    assert.throws(
      () => parseSanitizedJson(malicious),
      (err: any) => err instanceof PrototypePollutionError && err.statusCode === 400
    );
  });

  it("strips prototype keys when stripPrototypeKeys option is enabled", () => {
    const payload = '{"user": "bob", "__proto__": {"admin": true}, "valid": 123}';
    const parsed: any = parseSanitizedJson(payload, { stripPrototypeKeys: true });

    assert.equal(parsed.user, "bob");
    assert.equal(parsed.valid, 123);
    assert.equal(parsed.__proto__, Object.prototype);
  });

  it("enforces strict 1MB size limit on standard endpoints", () => {
    const oversized = JSON.stringify({ data: "x".repeat(DEFAULT_JSON_SIZE_LIMIT_BYTES + 10) });
    assert.throws(
      () => parseSanitizedJson(oversized),
      (err: any) => err instanceof PayloadTooLargeError && err.statusCode === 413
    );
  });

  it("allows payloads within 1MB limit", () => {
    const valid = JSON.stringify({ data: "hello", count: 42 });
    const parsed: any = parseSanitizedJson(valid);
    assert.equal(parsed.data, "hello");
    assert.equal(parsed.count, 42);
  });
});

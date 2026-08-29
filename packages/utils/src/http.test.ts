/**
 * Unit tests for `readBodyWithLimit` (#26/#27/#28/#29 — request body size limits).
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { readBodyWithLimit, PayloadTooLargeError, DEFAULT_BODY_SIZE_LIMIT_BYTES } from "./http.js";

function makeReq(): IncomingMessage & EventEmitter {
  return new EventEmitter() as IncomingMessage & EventEmitter;
}

function emitBody(req: EventEmitter, chunks: string[]): void {
  for (const chunk of chunks) {
    req.emit("data", Buffer.from(chunk));
  }
  req.emit("end");
}

describe("readBodyWithLimit", () => {
  it("resolves with the full body when under the limit", async () => {
    const req = makeReq();
    const promise = readBodyWithLimit(req, 1024);
    emitBody(req, ['{"hello":', '"world"}']);

    await expect(promise).resolves.toBe('{"hello":"world"}');
  });

  it("rejects with PayloadTooLargeError when the body exceeds the limit", async () => {
    const req = makeReq();
    const limit = 10;
    const promise = readBodyWithLimit(req, limit);
    emitBody(req, ["a".repeat(20)]);

    await expect(promise).rejects.toBeInstanceOf(PayloadTooLargeError);
    await expect(promise).rejects.toMatchObject({ limitBytes: limit });
  });

  it("rejects as soon as the cumulative size crosses the limit across multiple chunks", async () => {
    const req = makeReq();
    const limit = 10;
    const promise = readBodyWithLimit(req, limit);
    emitBody(req, ["a".repeat(6), "b".repeat(6)]);

    await expect(promise).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("defaults to a 1 MiB limit when none is provided", async () => {
    const req = makeReq();
    const promise = readBodyWithLimit(req);
    emitBody(req, ["small body"]);

    await expect(promise).resolves.toBe("small body");
    expect(DEFAULT_BODY_SIZE_LIMIT_BYTES).toBe(1024 * 1024);
  });

  it("propagates request stream errors", async () => {
    const req = makeReq();
    const promise = readBodyWithLimit(req, 1024);
    req.emit("error", new Error("stream broke"));

    await expect(promise).rejects.toThrow("stream broke");
  });

  it("resolves with an empty string when the body is empty", async () => {
    const req = makeReq();
    const promise = readBodyWithLimit(req, 1024);
    req.emit("end");

    await expect(promise).resolves.toBe("");
  });
});

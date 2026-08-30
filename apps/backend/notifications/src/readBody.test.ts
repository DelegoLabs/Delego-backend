/**
 * Unit tests for the request body size limit on readBody (#27).
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { PayloadTooLargeError } from "@delegolabs/utils";
import { readBody } from "./readBody.js";

function createMockReq(body: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

describe("readBody body size limit", () => {
  it("parses a body under the 1MB limit", async () => {
    const req = createMockReq(JSON.stringify({ hello: "world" }));

    await expect(readBody(req)).resolves.toEqual({ hello: "world" });
  });

  it("rejects a body over the 1MB limit with PayloadTooLargeError (413)", async () => {
    const oversizedBody = JSON.stringify({ padding: "a".repeat(1024 * 1024 + 1) });
    const req = createMockReq(oversizedBody);

    await expect(readBody(req)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("still rejects malformed JSON under the limit with a generic error", async () => {
    const req = createMockReq("not json");

    await expect(readBody(req)).rejects.toThrow("Invalid JSON body");
  });
});

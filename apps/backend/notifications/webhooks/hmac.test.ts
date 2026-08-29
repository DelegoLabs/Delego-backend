import { describe, it, expect } from "vitest";
import { signWebhookPayload } from "./hmac.js";
import { createHmac } from "node:crypto";

describe("signWebhookPayload", () => {
  it("produces a sha256=<hex> formatted signature", () => {
    const signature = signWebhookPayload("body", "secret");
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it("matches an independently computed HMAC-SHA256 digest", () => {
    const body = JSON.stringify({ hello: "world" });
    const secret = "my-secret";
    const expected = createHmac("sha256", secret).update(body, "utf8").digest("hex");
    expect(signWebhookPayload(body, secret)).toBe(`sha256=${expected}`);
  });

  it("produces different signatures for different secrets", () => {
    const body = "same body";
    expect(signWebhookPayload(body, "secret-a")).not.toBe(signWebhookPayload(body, "secret-b"));
  });

  it("produces different signatures for different bodies", () => {
    const secret = "same-secret";
    expect(signWebhookPayload("body-a", secret)).not.toBe(signWebhookPayload("body-b", secret));
  });
});

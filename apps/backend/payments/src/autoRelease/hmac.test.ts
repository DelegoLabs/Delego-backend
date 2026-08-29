import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "./hmac.js";

const SECRET = "test-webhook-secret";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed payload (raw hex signature)", () => {
    const body = JSON.stringify({ escrowId: "1", orderId: "order-1" });
    const signature = sign(body);

    expect(verifyWebhookSignature(body, signature, SECRET)).toBe(true);
  });

  it("accepts a correctly signed payload with a 'sha256=' prefix", () => {
    const body = JSON.stringify({ escrowId: "1", orderId: "order-1" });
    const signature = `sha256=${sign(body)}`;

    expect(verifyWebhookSignature(body, signature, SECRET)).toBe(true);
  });

  it("rejects a payload signed with the wrong secret", () => {
    const body = JSON.stringify({ escrowId: "1", orderId: "order-1" });
    const signature = sign(body, "wrong-secret");

    expect(verifyWebhookSignature(body, signature, SECRET)).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const body = JSON.stringify({ escrowId: "1", orderId: "order-1" });
    const signature = sign(body);
    const tamperedBody = JSON.stringify({ escrowId: "1", orderId: "order-2" });

    expect(verifyWebhookSignature(tamperedBody, signature, SECRET)).toBe(false);
  });

  it("rejects when the signature header is missing", () => {
    const body = JSON.stringify({ escrowId: "1" });
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "", SECRET)).toBe(false);
  });

  it("rejects when the secret is empty", () => {
    const body = JSON.stringify({ escrowId: "1" });
    const signature = sign(body);
    expect(verifyWebhookSignature(body, signature, "")).toBe(false);
  });

  it("rejects a malformed (non-hex) signature without throwing", () => {
    const body = JSON.stringify({ escrowId: "1" });
    expect(verifyWebhookSignature(body, "not-a-valid-signature!!", SECRET)).toBe(false);
  });

  it("rejects a signature of the wrong length", () => {
    const body = JSON.stringify({ escrowId: "1" });
    expect(verifyWebhookSignature(body, "abcd", SECRET)).toBe(false);
  });
});

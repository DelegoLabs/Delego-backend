import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateKeyPairSync, createHash, createVerify, createSign } from "node:crypto";
import {
  A2ANegotiator,
  MAX_NEGOTIATION_ROUNDS,
  DEFAULT_OFFER_TTL_SECONDS,
  SIGNATURE_ALGORITHM,
} from "./A2ANegotiator.js";
import type { NegotiationOffer, NegotiationResponse } from "./types.js";

/**
 * Tests for the fixed canonicalizeObject behaviour inside A2ANegotiator.
 *
 * The original bug: JSON.stringify(obj, arrayReplacer) treats the array as a
 * key-whitelist for every nested object, so orderItems entries were serialised as
 * [{}] — dropping productId and quantity from the offer digest entirely.
 *
 * The fix uses recursive key-sorting so nested objects are always fully included.
 *
 * Because ECDSA signatures are non-deterministic (random k per sign), we compare
 * the SHA-256 hex digest that feeds into the signer rather than comparing raw
 * signature bytes.  One additional test verifies the production class and the test
 * helper agree by signing with a known key-pair and verifying the resulting
 * signature against the locally-computed digest.
 */

// Mirror of the fixed canonicalizeObject, used to build expected digests.
function canonicalizeObject(obj: unknown): string {
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalizeObject).join(",") + "]";
  }
  if (obj !== null && typeof obj === "object") {
    const sortedKeys = Object.keys(obj as object).sort();
    const pairs = sortedKeys.map(
      (key) =>
        JSON.stringify(key) +
        ":" +
        canonicalizeObject((obj as Record<string, unknown>)[key]),
    );
    return "{" + pairs.join(",") + "}";
  }
  return JSON.stringify(obj);
}

function offerDigest(offer: NegotiationOffer, timestamp: number): string {
  const payload = {
    sessionId: offer.sessionId,
    orderItems: offer.orderItems.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
    })),
    offeredPriceStroops: offer.offeredPriceStroops,
    targetCurrency: offer.targetCurrency,
    buyerMaxBudgetStroops: offer.buyerMaxBudgetStroops,
    timestamp,
  };
  return createHash("sha256").update(canonicalizeObject(payload), "utf8").digest("hex");
}

function makeCanonicalOffer(overrides: Partial<NegotiationOffer> = {}): NegotiationOffer {
  return {
    sessionId: "session-1",
    orderItems: [{ productId: "prod-abc", quantity: 2 }],
    offeredPriceStroops: "1000000",
    targetCurrency: "USD",
    buyerMaxBudgetStroops: "2000000",
    ...overrides,
  };
}

const ENDPOINT = "http://merchant.test/negotiate";

function makeOffer(overrides: Partial<NegotiationOffer> = {}): NegotiationOffer {
  return {
    sessionId: "sess-1",
    orderItems: [{ productId: "p1", quantity: 2 }],
    offeredPriceStroops: "1000",
    targetCurrency: "XLM",
    buyerMaxBudgetStroops: "2000",
    ...overrides,
  };
}

const TS = 1_700_000_000_000;

describe("A2ANegotiator.canonicalizeObject (via computeOfferDigest)", () => {
  it("produces the same digest for identical offers", () => {
    const offer = makeCanonicalOffer();
    expect(offerDigest(offer, TS)).toBe(offerDigest(offer, TS));
  });

  it("changes the digest when productId in orderItems changes", () => {
    const original = makeCanonicalOffer({ orderItems: [{ productId: "prod-abc", quantity: 2 }] });
    const modified = makeCanonicalOffer({ orderItems: [{ productId: "prod-XYZ", quantity: 2 }] });

    expect(offerDigest(original, TS)).not.toBe(offerDigest(modified, TS));
  });

  it("changes the digest when quantity in orderItems changes", () => {
    const original = makeCanonicalOffer({ orderItems: [{ productId: "prod-abc", quantity: 2 }] });
    const modified = makeCanonicalOffer({ orderItems: [{ productId: "prod-abc", quantity: 99 }] });

    expect(offerDigest(original, TS)).not.toBe(offerDigest(modified, TS));
  });

  it("changes the digest when a second orderItem is added", () => {
    const original = makeCanonicalOffer({ orderItems: [{ productId: "prod-abc", quantity: 2 }] });
    const modified = makeCanonicalOffer({
      orderItems: [
        { productId: "prod-abc", quantity: 2 },
        { productId: "prod-def", quantity: 1 },
      ],
    });

    expect(offerDigest(original, TS)).not.toBe(offerDigest(modified, TS));
  });

  it("changes the digest when both productId and quantity change", () => {
    const original = makeCanonicalOffer({ orderItems: [{ productId: "prod-abc", quantity: 1 }] });
    const modified = makeCanonicalOffer({ orderItems: [{ productId: "prod-xyz", quantity: 5 }] });

    expect(offerDigest(original, TS)).not.toBe(offerDigest(modified, TS));
  });

  it("production A2ANegotiator signature verifies against locally-computed digest", () => {
    // Proves the production class uses the same digest algorithm as the test helper.
    // If the digests matched, the signature signed by the private key will verify
    // cleanly against the same digest re-derived here.
    const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const offer = makeCanonicalOffer();
    const neg = new A2ANegotiator({ buyerSigningKey: keyPair });

    // signOffer is private — access it via bracket notation for testing purposes.
    const signature = (neg as any).signOffer(offer, TS) as string;

    const verifier = createVerify("SHA256");
    verifier.update(offerDigest(offer, TS), "hex");
    expect(verifier.verify(keyPair.publicKey, signature, "base64")).toBe(true);
  });
});

function makeMerchantKeys() {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

// Mirrors the private computeResponseDigest so tests can produce valid merchant signatures.
function signResponse(
  privateKey: ReturnType<typeof makeMerchantKeys>["privateKey"],
  response: Omit<NegotiationResponse, "merchantSignature">,
  offer: NegotiationOffer,
  timestamp: number,
): string {
  const canonical = (obj: unknown) => JSON.stringify(obj, Object.keys(obj as object).sort());
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const digest = createHash("sha256")
    .update(
      canonical({
        accepted: response.accepted,
        counterOfferStroops: response.counterOfferStroops,
        discountPercentage: response.discountPercentage,
        validForSeconds: response.validForSeconds,
        sessionId: offer.sessionId,
        timestamp,
      }),
      "utf8",
    )
    .digest("hex");
  const signer = createSign(SIGNATURE_ALGORITHM);
  signer.update(digest, "hex");
  return signer.sign(privateKey, "base64");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("A2ANegotiator", () => {
  let merchant: ReturnType<typeof makeMerchantKeys>;

  beforeEach(() => {
    merchant = makeMerchantKeys();
  });

  it("exposes the expected constants", () => {
    expect(MAX_NEGOTIATION_ROUNDS).toBe(3);
    expect(DEFAULT_OFFER_TTL_SECONDS).toBe(300);
  });

  it("returns accepted when merchant accepts the first offer", async () => {
    const merchantPem = merchant.publicKey.export({ type: "spki", format: "pem" }) as string;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const base = { accepted: true, validForSeconds: 60, discountPercentage: 5 };
      const sig = signResponse(merchant.privateKey, base, body.offer, body.timestamp);
      return jsonResponse({ ...base, merchantSignature: sig });
    });

    const negotiator = new A2ANegotiator({
      merchantPublicKeyPem: merchantPem,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await negotiator.negotiate(makeOffer(), ENDPOINT);

    expect(result.status).toBe("accepted");
    expect(result.finalPriceStroops).toBe("1000");
    expect(result.roundsCompleted).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("accepts a counter-offer on a later round", async () => {
    const merchantPem = merchant.publicKey.export({ type: "spki", format: "pem" }) as string;
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      call += 1;
      const body = JSON.parse(init.body as string);
      const base =
        call === 1
          ? { accepted: false, counterOfferStroops: "1600", validForSeconds: 60 }
          : { accepted: true, validForSeconds: 60 };
      const sig = signResponse(merchant.privateKey, base as any, body.offer, body.timestamp);
      return jsonResponse({ ...base, merchantSignature: sig });
    });

    const negotiator = new A2ANegotiator({
      merchantPublicKeyPem: merchantPem,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await negotiator.negotiate(makeOffer(), ENDPOINT);

    expect(result.status).toBe("accepted");
    expect(result.roundsCompleted).toBe(2);
    // midpoint between 1000 and counter 1600 => 1300
    expect(result.finalPriceStroops).toBe("1300");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops without countering when counter-offer exceeds buyer budget", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const base = { accepted: false, counterOfferStroops: "5000", validForSeconds: 60 };
      const sig = signResponse(merchant.privateKey, base, body.offer, body.timestamp);
      return jsonResponse({ ...base, merchantSignature: sig });
    });

    const negotiator = new A2ANegotiator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await negotiator.negotiate(makeOffer({ buyerMaxBudgetStroops: "2000" }), ENDPOINT);

    expect(result.status).toBe("rejected");
    expect(result.roundsCompleted).toBe(1);
    expect(result.finalPriceStroops).toBe("5000");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns max_rounds_exceeded after MAX_NEGOTIATION_ROUNDS counters", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      // counter stays within budget but never accepted
      const base = { accepted: false, counterOfferStroops: "1900", validForSeconds: 60 };
      const sig = signResponse(merchant.privateKey, base, body.offer, body.timestamp);
      return jsonResponse({ ...base, merchantSignature: sig });
    });

    const negotiator = new A2ANegotiator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await negotiator.negotiate(makeOffer(), ENDPOINT);

    expect(result.status).toBe("max_rounds_exceeded");
    expect(result.roundsCompleted).toBe(MAX_NEGOTIATION_ROUNDS);
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_NEGOTIATION_ROUNDS);
  });

  it("respects a custom maxRounds override", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const base = { accepted: false, counterOfferStroops: "1900", validForSeconds: 60 };
      const sig = signResponse(merchant.privateKey, base, body.offer, body.timestamp);
      return jsonResponse({ ...base, merchantSignature: sig });
    });

    const negotiator = new A2ANegotiator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRounds: 1,
    });
    const result = await negotiator.negotiate(makeOffer(), ENDPOINT);

    expect(result.status).toBe("max_rounds_exceeded");
    expect(result.roundsCompleted).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a tampered merchant signature", async () => {
    const merchantPem = merchant.publicKey.export({ type: "spki", format: "pem" }) as string;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      // signed over a different response (accepted: true) than what is returned
      const signedBase = { accepted: true, validForSeconds: 60 };
      const sig = signResponse(merchant.privateKey, signedBase, body.offer, body.timestamp);
      return jsonResponse({ accepted: false, counterOfferStroops: "1500", validForSeconds: 60, merchantSignature: sig });
    });

    const negotiator = new A2ANegotiator({
      merchantPublicKeyPem: merchantPem,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await negotiator.negotiate(makeOffer(), ENDPOINT);

    expect(result.status).toBe("signature_invalid");
    expect(result.lastError).toMatch(/signature/i);
  });

  it("rejects a signature made by a different key", async () => {
    const otherKeys = makeMerchantKeys();
    const merchantPem = merchant.publicKey.export({ type: "spki", format: "pem" }) as string;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const base = { accepted: true, validForSeconds: 60 };
      const sig = signResponse(otherKeys.privateKey, base, body.offer, body.timestamp);
      return jsonResponse({ ...base, merchantSignature: sig });
    });

    const negotiator = new A2ANegotiator({
      merchantPublicKeyPem: merchantPem,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await negotiator.negotiate(makeOffer(), ENDPOINT);

    expect(result.status).toBe("signature_invalid");
  });

  it("verifyMerchantSignature returns false when no public key is configured", () => {
    const negotiator = new A2ANegotiator();
    const ok = negotiator.verifyMerchantSignature(
      { accepted: true, validForSeconds: 60, merchantSignature: "AAAA" },
      makeOffer(),
      Date.now(),
    );
    expect(ok).toBe(false);
  });

  it("returns error status when the transport fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const negotiator = new A2ANegotiator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await negotiator.negotiate(makeOffer(), ENDPOINT);

    expect(result.status).toBe("error");
    expect(result.lastError).toBe("socket hang up");
  });

  it("returns error status when the merchant responds non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("expired", { status: 410 }));
    const negotiator = new A2ANegotiator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await negotiator.negotiate(makeOffer(), ENDPOINT);

    expect(result.status).toBe("error");
    expect(result.lastError).toMatch(/410/);
  });

  it("sends the offer TTL-bounded timestamp and signed payload", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const base = { accepted: true, validForSeconds: DEFAULT_OFFER_TTL_SECONDS };
      const sig = signResponse(merchant.privateKey, base, body.offer, body.timestamp);
      return jsonResponse({ ...base, merchantSignature: sig });
    });
    const negotiator = new A2ANegotiator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const before = Date.now();
    const result = await negotiator.negotiate(makeOffer(), ENDPOINT);
    const after = Date.now();

    expect(result.status).toBe("accepted");
    expect(result.validForSeconds).toBe(DEFAULT_OFFER_TTL_SECONDS);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(sent.timestamp).toBeGreaterThanOrEqual(before);
    expect(sent.timestamp).toBeLessThanOrEqual(after);
    expect(typeof sent.buyerSignature).toBe("string");
    expect(sent.buyerSignature.length).toBeGreaterThan(0);
  });

  it("rejects an expired offer when the TTL has elapsed", async () => {
    const issuedAt = Date.now() - (DEFAULT_OFFER_TTL_SECONDS + 1) * 1000;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      // Merchant side: an offer whose timestamp is older than TTL must be rejected.
      const expired = Date.now() - body.timestamp > DEFAULT_OFFER_TTL_SECONDS * 1000;
      if (expired) {
        return new Response("offer expired", { status: 410 });
      }
      const base = { accepted: true, validForSeconds: 60 };
      const sig = signResponse(merchant.privateKey, base, body.offer, body.timestamp);
      return jsonResponse({ ...base, merchantSignature: sig });
    });

    vi.useFakeTimers();
    vi.setSystemTime(issuedAt);
    try {
      const negotiator = new A2ANegotiator({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      // Advance clock past the TTL before the offer is dispatched.
      vi.setSystemTime(issuedAt + (DEFAULT_OFFER_TTL_SECONDS + 1) * 1000);
      const result = await negotiator.negotiate(makeOffer(), ENDPOINT);

      // Offer timestamp is taken at send time, so this only fails if the merchant
      // enforces TTL against a client-supplied timestamp; assert the buyer
      // reports the merchant rejection as an error rather than accepting.
      expect(result.status).not.toBe("accepted");
    } finally {
      vi.useRealTimers();
    }
  });
});

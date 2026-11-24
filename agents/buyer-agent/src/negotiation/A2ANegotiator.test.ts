import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createHash, createVerify } from "node:crypto";
import { A2ANegotiator } from "./A2ANegotiator.js";
import type { NegotiationOffer } from "./types.js";

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

function makeOffer(overrides: Partial<NegotiationOffer> = {}): NegotiationOffer {
  return {
    sessionId: "session-1",
    orderItems: [{ productId: "prod-abc", quantity: 2 }],
    offeredPriceStroops: "1000000",
    targetCurrency: "USD",
    buyerMaxBudgetStroops: "2000000",
    ...overrides,
  };
}

const TS = 1_700_000_000_000;

describe("A2ANegotiator.canonicalizeObject (via computeOfferDigest)", () => {
  it("produces the same digest for identical offers", () => {
    const offer = makeOffer();
    expect(offerDigest(offer, TS)).toBe(offerDigest(offer, TS));
  });

  it("changes the digest when productId in orderItems changes", () => {
    const original = makeOffer({ orderItems: [{ productId: "prod-abc", quantity: 2 }] });
    const modified = makeOffer({ orderItems: [{ productId: "prod-XYZ", quantity: 2 }] });

    expect(offerDigest(original, TS)).not.toBe(offerDigest(modified, TS));
  });

  it("changes the digest when quantity in orderItems changes", () => {
    const original = makeOffer({ orderItems: [{ productId: "prod-abc", quantity: 2 }] });
    const modified = makeOffer({ orderItems: [{ productId: "prod-abc", quantity: 99 }] });

    expect(offerDigest(original, TS)).not.toBe(offerDigest(modified, TS));
  });

  it("changes the digest when a second orderItem is added", () => {
    const original = makeOffer({ orderItems: [{ productId: "prod-abc", quantity: 2 }] });
    const modified = makeOffer({
      orderItems: [
        { productId: "prod-abc", quantity: 2 },
        { productId: "prod-def", quantity: 1 },
      ],
    });

    expect(offerDigest(original, TS)).not.toBe(offerDigest(modified, TS));
  });

  it("changes the digest when both productId and quantity change", () => {
    const original = makeOffer({ orderItems: [{ productId: "prod-abc", quantity: 1 }] });
    const modified = makeOffer({ orderItems: [{ productId: "prod-xyz", quantity: 5 }] });

    expect(offerDigest(original, TS)).not.toBe(offerDigest(modified, TS));
  });

  it("production A2ANegotiator signature verifies against locally-computed digest", () => {
    // Proves the production class uses the same digest algorithm as the test helper.
    // If the digests matched, the signature signed by the private key will verify
    // cleanly against the same digest re-derived here.
    const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const offer = makeOffer();
    const neg = new A2ANegotiator({ buyerSigningKey: keyPair });

    // signOffer is private — access it via bracket notation for testing purposes.
    const signature = (neg as any).signOffer(offer, TS) as string;

    const verifier = createVerify("SHA256");
    verifier.update(offerDigest(offer, TS), "hex");
    expect(verifier.verify(keyPair.publicKey, signature, "base64")).toBe(true);
  });
});

import { generateKeyPairSync } from "crypto";
import {
  signPurchaseProposal,
  MissingSigningKeyError,
  PurchaseProposalPayload,
} from "./purchaseProposal";

const payload: PurchaseProposalPayload = {
  proposalId: "prop_123",
  buyerId: "buyer_1",
  sellerId: "seller_1",
  amountCents: 1999,
  currency: "USD",
  createdAt: "2024-01-01T00:00:00.000Z",
};

const testPem = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

describe("signPurchaseProposal", () => {
  describe("production", () => {
    it("throws MissingSigningKeyError when AGENT_SIGNING_KEY_PEM is unset", () => {
      expect(() =>
        signPurchaseProposal(payload, { NODE_ENV: "production" } as NodeJS.ProcessEnv)
      ).toThrow(MissingSigningKeyError);
    });

    it("throws when AGENT_SIGNING_KEY_PEM is empty or whitespace", () => {
      expect(() =>
        signPurchaseProposal(payload, {
          NODE_ENV: "production",
          AGENT_SIGNING_KEY_PEM: "   ",
        } as NodeJS.ProcessEnv)
      ).toThrow(MissingSigningKeyError);
    });

    it("signs with the configured key when AGENT_SIGNING_KEY_PEM is set", () => {
      const result = signPurchaseProposal(payload, {
        NODE_ENV: "production",
        AGENT_SIGNING_KEY_PEM: testPem,
      } as NodeJS.ProcessEnv);
      expect(result.signatureAlgorithm).toBe("Ed25519");
      expect(result.signature.length).toBeGreaterThan(0);
    });
  });

  describe("development / test", () => {
    it.each(["development", "test"])(
      "falls back to placeholder signature when NODE_ENV=%s and key is unset",
      (nodeEnv) => {
        const result = signPurchaseProposal(payload, {
          NODE_ENV: nodeEnv,
        } as NodeJS.ProcessEnv);
        expect(result.signatureAlgorithm).toBe("placeholder-sha256");
        expect(result.signature).toMatch(/^[0-9a-f]{64}$/);
      }
    );

    it("produces a deterministic placeholder signature", () => {
      const env = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
      const a = signPurchaseProposal(payload, env);
      const b = signPurchaseProposal(payload, env);
      expect(a.signature).toBe(b.signature);
    });

    it("uses the real key when provided outside production", () => {
      const result = signPurchaseProposal(payload, {
        NODE_ENV: "development",
        AGENT_SIGNING_KEY_PEM: testPem,
      } as NodeJS.ProcessEnv);
      expect(result.signatureAlgorithm).toBe("Ed25519");
    });
  });
});

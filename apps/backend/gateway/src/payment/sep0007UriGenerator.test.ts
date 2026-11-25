/**
 * Unit tests for SEP-0007 URI Generator
 */

import { describe, it, expect } from "vitest";
import { Sep0007UriGenerator, type Sep0007UriParams } from "./sep0007UriGenerator.js";

describe("Sep0007UriGenerator", () => {
  const generator = new Sep0007UriGenerator();

  const VALID_DESTINATION = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
  const VALID_ISSUER = "GB7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVTH7";

  describe("generatePaymentUri", () => {
    describe("basic functionality", () => {
      it("generates valid URI with required parameters only", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "100",
        });

        expect(result.success).toBe(true);
        expect(result.uri).toBeDefined();
        expect(result.uri).toContain("web+stellar:pay?");
        expect(result.uri).toContain(`destination=${VALID_DESTINATION}`);
        expect(result.uri).toContain("amount=100");
      });

      it("generates URI with all parameters", () => {
        const params: Sep0007UriParams = {
          destination: VALID_DESTINATION,
          amount: "50.25",
          assetCode: "USD",
          assetIssuer: VALID_ISSUER,
          memo: "Payment for invoice #12345",
          memoType: "text",
          callbackUrl: "https://api.example.com/webhooks/payment",
          message: "Pay merchant XYZ",
          networkPassphrase: "Public Global Stellar Network ; September 2015",
          origin: "example.com",
        };

        const result = generator.generatePaymentUri(params);

        expect(result.success).toBe(true);
        expect(result.uri).toContain("web+stellar:pay?");
        expect(result.uri).toContain(`destination=${VALID_DESTINATION}`);
        expect(result.uri).toContain("amount=50.25");
        expect(result.uri).toContain("asset_code=USD");
        expect(result.uri).toContain(`asset_issuer=${VALID_ISSUER}`);
        expect(result.uri).toContain("memo=");
        expect(result.uri).toContain("memo_type=text");
        expect(result.uri).toContain("callback=");
        expect(result.uri).toContain("msg=");
      });

      it("generates URI for native XLM asset without issuer", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "10",
          assetCode: "XLM",
        });

        expect(result.success).toBe(true);
        expect(result.uri).toContain("asset_code=XLM");
        expect(result.uri).not.toContain("asset_issuer");
      });
    });

    describe("parameter validation", () => {
      it("rejects missing destination", () => {
        const result = generator.generatePaymentUri({
          destination: "",
          amount: "100",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("destination");
      });

      it("rejects invalid destination format", () => {
        const result = generator.generatePaymentUri({
          destination: "invalid-address",
          amount: "100",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid destination");
      });

      it("rejects missing amount", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("amount");
      });

      it("rejects invalid amount format", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "not-a-number",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid amount");
      });

      it("rejects negative amount", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "-10",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("positive number");
      });

      it("rejects zero amount", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "0",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("positive number");
      });

      it("requires asset issuer for non-XLM assets", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "100",
          assetCode: "USD",
          // Missing assetIssuer
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("assetIssuer is required");
      });

      it("rejects invalid asset issuer format", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "100",
          assetCode: "USD",
          assetIssuer: "invalid-issuer",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid assetIssuer");
      });

      it("rejects invalid memo type", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "100",
          memo: "test",
          // @ts-expect-error Testing invalid memo type
          memoType: "invalid",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid memoType");
      });

      it("rejects invalid memo ID format", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "100",
          memo: "not-a-number",
          memoType: "id",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("must be a non-negative integer");
      });

      it("rejects negative memo ID", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "100",
          memo: "-123",
          memoType: "id",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("non-negative integer");
      });

      it("rejects invalid memo hash length", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "100",
          memo: "tooshort",
          memoType: "hash",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("64 hex characters");
      });

      it("rejects invalid callback URL format", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "100",
          callbackUrl: "not-a-valid-url",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid callbackUrl");
      });
    });

    describe("special character encoding", () => {
      it("encodes special characters in memo", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "100",
          memo: "Payment with spaces & special chars! @#$%",
          memoType: "text",
        });

        expect(result.success).toBe(true);
        expect(result.uri).toContain("memo=");
        // Verify URI is still valid after encoding
        expect(result.uri).toMatch(/^web\+stellar:pay\?/);
      });

      it("encodes Unicode characters safely", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "100",
          memo: "支付 Payment 😀",
          memoType: "text",
        });

        expect(result.success).toBe(true);
        expect(result.uri).toContain("memo=");
      });

      it("encodes callback URL with query parameters", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "100",
          callbackUrl: "https://api.example.com/webhook?key=value&token=abc123",
        });

        expect(result.success).toBe(true);
        expect(result.uri).toContain("callback=");
        // Verify ampersands and equals signs are encoded
        expect(result.uri).not.toContain("callback=https://api.example.com/webhook?key=value&token=abc123");
      });
    });

    describe("warnings", () => {
      it("warns about long text memos", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "100",
          memo: "This is a very long memo that exceeds 28 characters",
          memoType: "text",
        });

        expect(result.success).toBe(true);
        expect(result.warnings).toBeDefined();
        expect(result.warnings![0]).toContain("28 characters");
      });

      it("does not warn for short text memos", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "100",
          memo: "Short memo",
          memoType: "text",
        });

        expect(result.success).toBe(true);
        expect(result.warnings).toBeUndefined();
      });

      it("does not warn for long ID memos (but should fail validation)", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "100",
          memo: "123456789012",
          memoType: "id",
        });

        expect(result.success).toBe(true); // Long IDs are valid
        expect(result.warnings).toBeUndefined();
      });
    });

    describe("decimal amounts", () => {
      it("handles decimal amounts correctly", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "123.4567890",
        });

        expect(result.success).toBe(true);
        expect(result.uri).toContain("amount=123.4567890");
      });

      it("handles very small amounts", () => {
        const result = generator.generatePaymentUri({
          destination: VALID_DESTINATION,
          amount: "0.0000001",
        });

        expect(result.success).toBe(true);
        expect(result.uri).toContain("amount=0.0000001");
      });
    });
  });

  describe("decodePaymentUri", () => {
    it("decodes a basic payment URI", () => {
      const uri = `web+stellar:pay?destination=${VALID_DESTINATION}&amount=100`;
      const params = generator.decodePaymentUri(uri);

      expect(params).not.toBeNull();
      expect(params!.destination).toBe(VALID_DESTINATION);
      expect(params!.amount).toBe("100");
    });

    it("decodes URI with all parameters", () => {
      const originalParams: Sep0007UriParams = {
        destination: VALID_DESTINATION,
        amount: "50.25",
        assetCode: "USD",
        assetIssuer: VALID_ISSUER,
        memo: "Test payment",
        memoType: "text",
        callbackUrl: "https://api.example.com/webhook",
      };

      const result = generator.generatePaymentUri(originalParams);
      expect(result.success).toBe(true);

      const decoded = generator.decodePaymentUri(result.uri!);
      expect(decoded).not.toBeNull();
      expect(decoded!.destination).toBe(originalParams.destination);
      expect(decoded!.amount).toBe(originalParams.amount);
      expect(decoded!.assetCode).toBe(originalParams.assetCode);
      expect(decoded!.assetIssuer).toBe(originalParams.assetIssuer);
      expect(decoded!.memo).toBe(originalParams.memo);
      expect(decoded!.memoType).toBe(originalParams.memoType);
      expect(decoded!.callbackUrl).toBe(originalParams.callbackUrl);
    });

    it("decodes URI with encoded special characters", () => {
      const originalParams: Sep0007UriParams = {
        destination: VALID_DESTINATION,
        amount: "100",
        memo: "Payment & Test!",
        memoType: "text",
      };

      const result = generator.generatePaymentUri(originalParams);
      const decoded = generator.decodePaymentUri(result.uri!);

      expect(decoded).not.toBeNull();
      expect(decoded!.memo).toBe(originalParams.memo);
    });

    it("returns null for invalid URI scheme", () => {
      const uri = `https://example.com?destination=${VALID_DESTINATION}&amount=100`;
      const params = generator.decodePaymentUri(uri);

      expect(params).toBeNull();
    });

    it("returns null for malformed URI", () => {
      const uri = "web+stellar:pay?invalid";
      const params = generator.decodePaymentUri(uri);

      expect(params).toBeNull();
    });

    it("returns null for URI missing required parameters", () => {
      const uri = "web+stellar:pay?destination=GAQAA...";
      const params = generator.decodePaymentUri(uri);

      expect(params).toBeNull();
    });
  });

  describe("round-trip encoding", () => {
    it("maintains data integrity through encode/decode cycle", () => {
      const originalParams: Sep0007UriParams = {
        destination: VALID_DESTINATION,
        amount: "123.456",
        assetCode: "EUR",
        assetIssuer: VALID_ISSUER,
        memo: "Invoice #9876 with special chars: & = ?",
        memoType: "text",
        callbackUrl: "https://api.example.com/payment?id=123&token=abc",
        message: "Payment to Merchant ABC",
      };

      const encodeResult = generator.generatePaymentUri(originalParams);
      expect(encodeResult.success).toBe(true);

      const decoded = generator.decodePaymentUri(encodeResult.uri!);
      expect(decoded).not.toBeNull();

      expect(decoded!.destination).toBe(originalParams.destination);
      expect(decoded!.amount).toBe(originalParams.amount);
      expect(decoded!.assetCode).toBe(originalParams.assetCode);
      expect(decoded!.assetIssuer).toBe(originalParams.assetIssuer);
      expect(decoded!.memo).toBe(originalParams.memo);
      expect(decoded!.memoType).toBe(originalParams.memoType);
      expect(decoded!.callbackUrl).toBe(originalParams.callbackUrl);
      expect(decoded!.message).toBe(originalParams.message);
    });
  });
});

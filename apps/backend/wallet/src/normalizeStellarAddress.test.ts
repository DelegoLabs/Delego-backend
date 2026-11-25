import { describe, expect, it } from "vitest";
import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import { normalizeStellarAddress } from "./normalizeStellarAddress.js";

describe("normalizeStellarAddress", () => {
  it("accepts a valid G... Ed25519 public key and trims surrounding whitespace", () => {
    const publicKey = Keypair.random().publicKey();
    const input = `  \t${publicKey}\n `;

    const result = normalizeStellarAddress(input);

    expect(result).toEqual({
      original: input,
      normalized: publicKey,
      valid: true,
    });
  });

  it("rejects empty and whitespace-only strings", () => {
    expect(normalizeStellarAddress("")).toEqual({
      original: "",
      normalized: "",
      valid: false,
    });
    expect(normalizeStellarAddress("   \t\n  ")).toEqual({
      original: "   \t\n  ",
      normalized: "",
      valid: false,
    });
  });

  it("rejects non-string inputs defensively", () => {
    const result = normalizeStellarAddress(null as unknown as string);
    expect(result).toEqual({
      original: "",
      normalized: "",
      valid: false,
    });
  });

  it("rejects S... secret seeds", () => {
    const secret = Keypair.random().secret();

    const result = normalizeStellarAddress(` ${secret} `);

    expect(result).toEqual({
      original: ` ${secret} `,
      normalized: secret,
      valid: false,
    });
  });

  it("rejects M... muxed addresses (only G... Ed25519 public keys are accepted)", () => {
    const basePublicKey = Keypair.random().publicKey();
    const muxedAddress = new MuxedAccount(
      new Account(basePublicKey, "1"),
      "123456789"
    ).accountId();

    expect(muxedAddress.startsWith("M")).toBe(true);

    const result = normalizeStellarAddress(` ${muxedAddress} `);

    expect(result).toEqual({
      original: ` ${muxedAddress} `,
      normalized: muxedAddress,
      valid: false,
    });
  });

  it("rejects lowercase and malformed G... addresses", () => {
    const publicKey = Keypair.random().publicKey();
    const lower = publicKey.toLowerCase();

    expect(normalizeStellarAddress(lower)).toEqual({
      original: lower,
      normalized: lower,
      valid: false,
    });

    const malformed = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(normalizeStellarAddress(malformed)).toEqual({
      original: malformed,
      normalized: malformed,
      valid: false,
    });
  });
});

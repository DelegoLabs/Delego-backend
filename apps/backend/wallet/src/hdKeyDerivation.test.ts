import { afterEach, describe, expect, it } from "vitest";
import {
  backupMasterSeed,
  clearDerivationAuditTrail,
  deriveChildKey,
  deriveKeyFromMnemonic,
  deriveKeyHierarchy,
  getDerivationAuditTrail,
  recordDerivationAudit,
  restoreMasterSeed,
  validateMnemonic,
} from "./hdKeyDerivation.js";

const VALID_12_WORD_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const VALID_24_WORD_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

describe("hdKeyDerivation", () => {
  afterEach(() => {
    clearDerivationAuditTrail();
  });

  describe("validateMnemonic", () => {
    it("accepts valid 12-word and 24-word mnemonics", () => {
      expect(validateMnemonic(VALID_12_WORD_MNEMONIC)).toBe(true);
      expect(validateMnemonic(VALID_24_WORD_MNEMONIC)).toBe(true);
    });

    it("accepts valid mnemonics with extra surrounding or internal whitespace", () => {
      expect(validateMnemonic(`  ${VALID_12_WORD_MNEMONIC}  `)).toBe(true);
    });

    it("rejects mnemonics with invalid word counts or too-short words", () => {
      expect(validateMnemonic("")).toBe(false);
      expect(validateMnemonic("abandon abandon abandon")).toBe(false);
      expect(validateMnemonic(`${VALID_12_WORD_MNEMONIC} extra`)).toBe(false);
      expect(
        validateMnemonic(
          "a abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        )
      ).toBe(false);
    });
  });

  describe("deriveKeyFromMnemonic", () => {
    it("derives deterministic keys for the same mnemonic and path", () => {
      const first = deriveKeyFromMnemonic({ seed: VALID_12_WORD_MNEMONIC });
      const second = deriveKeyFromMnemonic({ seed: VALID_12_WORD_MNEMONIC });

      expect(first).toEqual(second);
      expect(first.path).toBe("m/148'/0'/0/0");
      expect(first.depth).toBe(4);
      expect(first.childNumber).toBe(0);
      expect(first.isHardened).toBe(false);
      expect(first.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(first.privateKey).toMatch(/^[0-9a-f]{64}$/);
      expect(first.chainCode).toMatch(/^[0-9a-f]{64}$/);
    });

    it("applies ed25519 clamping bits to the derived private key", () => {
      const derived = deriveKeyFromMnemonic({ seed: VALID_12_WORD_MNEMONIC });
      const privBytes = Buffer.from(derived.privateKey!, "hex");

      expect(privBytes[0] & 0x07).toBe(0);
      expect(privBytes[31] & 0x80).toBe(0);
      expect(privBytes[31] & 0x40).toBe(0x40);
    });

    it("derives distinct keys for different account, change, address, coinType, or passphrase", () => {
      const base = deriveKeyFromMnemonic({ seed: VALID_12_WORD_MNEMONIC });
      const diffAccount = deriveKeyFromMnemonic({
        seed: VALID_12_WORD_MNEMONIC,
        accountIndex: 1,
      });
      const diffChange = deriveKeyFromMnemonic({
        seed: VALID_12_WORD_MNEMONIC,
        changeIndex: 1,
      });
      const diffAddress = deriveKeyFromMnemonic({
        seed: VALID_12_WORD_MNEMONIC,
        addressIndex: 2,
      });
      const diffCoin = deriveKeyFromMnemonic({
        seed: VALID_12_WORD_MNEMONIC,
        coinType: 0,
      });
      const diffPassphrase = deriveKeyFromMnemonic({
        seed: VALID_12_WORD_MNEMONIC,
        passphrase: "my-secret-passphrase",
      });

      expect(diffAccount.path).toBe("m/148'/1'/0/0");
      expect(diffChange.path).toBe("m/148'/0'/1/0");
      expect(diffAddress.path).toBe("m/148'/0'/0/2");
      expect(diffCoin.path).toBe("m/0'/0'/0/0");

      const publicKeys = new Set([
        base.publicKey,
        diffAccount.publicKey,
        diffChange.publicKey,
        diffAddress.publicKey,
        diffCoin.publicKey,
        diffPassphrase.publicKey,
      ]);
      expect(publicKeys.size).toBe(6);
    });

    it("throws on an invalid mnemonic word count", () => {
      expect(() => deriveKeyFromMnemonic({ seed: "invalid short mnemonic" })).toThrow(
        /Invalid mnemonic word count/
      );
    });
  });

  describe("deriveKeyHierarchy", () => {
    it("derives a deterministic master key, accounts, and addresses matching deriveKeyFromMnemonic", () => {
      const hierarchy = deriveKeyHierarchy({ seed: VALID_12_WORD_MNEMONIC }, 2, 3);

      expect(hierarchy.masterKey.path).toBe("m");
      expect(hierarchy.masterKey.depth).toBe(0);
      expect(hierarchy.accounts).toHaveLength(2);

      for (let acctIdx = 0; acctIdx < 2; acctIdx++) {
        const account = hierarchy.accounts[acctIdx];
        expect(account.index).toBe(acctIdx);
        expect(account.extendedPublicKey).toMatch(/^[0-9a-f]{64}$/);
        expect(account.addresses).toHaveLength(3);

        for (let addrIdx = 0; addrIdx < 3; addrIdx++) {
          const addr = account.addresses[addrIdx];
          const single = deriveKeyFromMnemonic({
            seed: VALID_12_WORD_MNEMONIC,
            accountIndex: acctIdx,
            changeIndex: 0,
            addressIndex: addrIdx,
          });
          expect(addr.index).toBe(addrIdx);
          expect(addr.path).toBe(`m/148'/${acctIdx}'/0/${addrIdx}`);
          expect(addr.publicKey).toBe(single.publicKey);
          expect(addr.address).toBe(single.publicKey);
        }
      }
    });
  });

  describe("deriveChildKey", () => {
    it("derives deterministic non-hardened child keys from parent public key and chain code", () => {
      const parent = deriveKeyFromMnemonic({ seed: VALID_12_WORD_MNEMONIC });

      const child0a = deriveChildKey(parent.publicKey, parent.chainCode, 0);
      const child0b = deriveChildKey(parent.publicKey, parent.chainCode, 0, false);
      const child1 = deriveChildKey(parent.publicKey, parent.chainCode, 1);

      expect(child0a).toEqual(child0b);
      expect(child0a.path).toBe("m/0");
      expect(child0a.depth).toBe(1);
      expect(child0a.isHardened).toBe(false);
      expect(child1.path).toBe("m/1");
      expect(child0a.publicKey).not.toBe(child1.publicKey);
    });

    it("throws when attempting hardened derivation from a public key", () => {
      const parent = deriveKeyFromMnemonic({ seed: VALID_12_WORD_MNEMONIC });

      expect(() => deriveChildKey(parent.publicKey, parent.chainCode, 0, true)).toThrow(
        /Cannot derive hardened children from a public key only/
      );
    });
  });

  describe("backupMasterSeed and restoreMasterSeed", () => {
    it("backs up and restores the same master seed deterministically", () => {
      const backup = backupMasterSeed(VALID_12_WORD_MNEMONIC);
      const restored = restoreMasterSeed(backup.entropy);

      expect(backup.entropy).toMatch(/^[0-9a-f]{32}$/);
      expect(backup.seed).toMatch(/^[0-9a-f]{64}$/);
      expect(restored.seed).toBe(backup.seed);
      expect(Number.isNaN(Date.parse(backup.timestamp))).toBe(false);
      expect(Number.isNaN(Date.parse(restored.timestamp))).toBe(false);
    });

    it("produces a different seed when a passphrase is provided", () => {
      const withoutPassphrase = backupMasterSeed(VALID_12_WORD_MNEMONIC);
      const withPassphrase = backupMasterSeed(VALID_12_WORD_MNEMONIC, "extra-salt");

      expect(withPassphrase.entropy).toBe(withoutPassphrase.entropy);
      expect(withPassphrase.seed).not.toBe(withoutPassphrase.seed);
    });
  });

  describe("derivation audit trail", () => {
    it("records, filters by path prefix, and clears audit entries", () => {
      recordDerivationAudit({
        path: "m/148'/0'/0/0",
        action: "derive",
        accountIndex: 0,
        addressIndex: 0,
        coinType: 148,
        success: true,
      });
      recordDerivationAudit({
        path: "m/148'/1'/0/0",
        action: "backup",
        accountIndex: 1,
        addressIndex: 0,
        coinType: 148,
        success: false,
        error: "vault locked",
      });

      const all = getDerivationAuditTrail();
      expect(all).toHaveLength(2);
      expect(all[0].timestamp).toBeTruthy();

      const filtered = getDerivationAuditTrail("m/148'/1'");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].action).toBe("backup");
      expect(filtered[0].error).toBe("vault locked");

      clearDerivationAuditTrail();
      expect(getDerivationAuditTrail()).toHaveLength(0);
    });
  });
});

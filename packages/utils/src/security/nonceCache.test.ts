import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateNonce,
  InMemoryNonceStore,
  StaleTimestampError,
  ReplayedNonceError,
  NonceValidationError,
  buildNonceKey,
} from "./nonceCache.ts";

describe("nonceCache - Issue #617", () => {
  it("accepts a fresh, unique nonce and records it in cache", async () => {
    const redis = new InMemoryNonceStore();
    const now = Date.now();

    const success = await validateNonce(
      redis,
      {
        account: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
        nonce: "random-nonce-12345",
        timestamp: Math.floor(now / 1000), // seconds
        ttlSeconds: 300,
      },
      now
    );

    assert.equal(success, true);
  });

  it("rejects replayed nonce with HTTP 409 Conflict", async () => {
    const redis = new InMemoryNonceStore();
    const now = Date.now();
    const opts = {
      account: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
      nonce: "replayed-nonce-abc",
      timestamp: now, // milliseconds
      ttlSeconds: 300,
    };

    // First use passes
    await validateNonce(redis, opts, now);

    // Second use with identical account and nonce must fail with 409
    await assert.rejects(
      async () => validateNonce(redis, opts, now),
      (err: any) => err instanceof ReplayedNonceError && err.statusCode === 409
    );
  });

  it("allows identical nonce for different accounts", async () => {
    const redis = new InMemoryNonceStore();
    const now = Date.now();

    const res1 = await validateNonce(
      redis,
      {
        account: "ACCOUNT_A",
        nonce: "shared-nonce-val",
        timestamp: now,
        ttlSeconds: 300,
      },
      now
    );
    assert.equal(res1, true);

    const res2 = await validateNonce(
      redis,
      {
        account: "ACCOUNT_B",
        nonce: "shared-nonce-val",
        timestamp: now,
        ttlSeconds: 300,
      },
      now
    );
    assert.equal(res2, true);
  });

  it("rejects timestamps older than 60 seconds with HTTP 400 Bad Request", async () => {
    const redis = new InMemoryNonceStore();
    const now = Date.now();
    const staleTimestamp = now - 65_000; // 65 seconds ago

    await assert.rejects(
      async () =>
        validateNonce(
          redis,
          {
            account: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
            nonce: "nonce-stale-past",
            timestamp: staleTimestamp,
            ttlSeconds: 300,
          },
          now
        ),
      (err: any) => err instanceof StaleTimestampError && err.statusCode === 400
    );
  });

  it("rejects timestamps more than 60 seconds into the future with HTTP 400 Bad Request", async () => {
    const redis = new InMemoryNonceStore();
    const now = Date.now();
    const futureTimestamp = now + 70_000; // 70 seconds into future

    await assert.rejects(
      async () =>
        validateNonce(
          redis,
          {
            account: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
            nonce: "nonce-stale-future",
            timestamp: futureTimestamp,
            ttlSeconds: 300,
          },
          now
        ),
      (err: any) => err instanceof StaleTimestampError && err.statusCode === 400
    );
  });

  it("rejects missing account or nonce with HTTP 400", async () => {
    const redis = new InMemoryNonceStore();
    const now = Date.now();

    await assert.rejects(
      async () =>
        validateNonce(
          redis,
          {
            account: "",
            nonce: "some-nonce",
            timestamp: now,
            ttlSeconds: 300,
          },
          now
        ),
      (err: any) => err instanceof NonceValidationError && err.statusCode === 400
    );
  });
});

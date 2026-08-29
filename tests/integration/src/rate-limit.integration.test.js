/**
 * Integration coverage (Issue #36): rate limiting against real Redis.
 *
 * apps/backend/gateway/src/rateLimit/rateLimiter.ts's checkRateLimit()
 * accepts an optional `redisClient` override on RateLimitConfig
 * (src/rateLimit/types.ts). That's the seam this suite uses to run the
 * real limiter logic against a real ioredis connection instead of the
 * process-wide getRedisClient() singleton — which forces ioredis-mock
 * whenever NODE_ENV=test (see src/rateLimit/redisClient.ts), regardless
 * of MOCK_REDIS. Passing redisClient explicitly exercises the real
 * INCR/EXPIRE/pipeline behavior without needing to change that singleton
 * or run the whole suite with NODE_ENV unset.
 *
 * Note: the current limiter (buildKey() in rateLimiter.ts) is a
 * fixed-window counter keyed by `Math.floor(Date.now() / windowMs)`, not a
 * sliding-window log/bucket. These tests cover the algorithm as it
 * actually exists on main; they do not assert sliding-window semantics
 * (e.g. a rolling N-requests-per-any-windowMs-interval guarantee), since
 * the implementation does not provide those.
 *
 * Requires a reachable Redis; skips itself otherwise.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { isRedisReachable, isServiceBuilt, REDIS_URL, uniqueId } from "./helpers/infra.js";

const redisAvailable = await isRedisReachable();
if (!redisAvailable) {
  console.log(
    `[tests] Skipping rate-limit integration tests — no Redis reachable at ${REDIS_URL} (start it with 'docker compose up -d redis')`,
  );
}

const gatewayBuilt = isServiceBuilt("gateway");
if (redisAvailable && !gatewayBuilt) {
  console.log(
    "[tests] Skipping rate-limit integration tests — apps/backend/gateway/dist not found (run `pnpm --filter @delegolabs/gateway build` first)",
  );
}

const suite = redisAvailable && gatewayBuilt ? describe : describe.skip;

suite("rate limiting against real Redis (#36)", () => {
  let redis;
  let checkRateLimit;

  before(async () => {
    redis = new Redis(REDIS_URL);
    ({ checkRateLimit } = await import(
      "../../../apps/backend/gateway/dist/src/rateLimit/rateLimiter.js"
    ));
  });

  after(async () => {
    redis.disconnect();
  });

  it("allows requests under the limit and blocks once the limit is exceeded", async () => {
    const identifier = uniqueId("user");
    const endpoint = "POST:/api/v1/delegations";
    const config = { maxRequests: 3, windowMs: 60_000, redisClient: redis };

    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await checkRateLimit(identifier, endpoint, config));
    }

    assert.deepEqual(
      results.map((r) => r.allowed),
      [true, true, true, false],
      "the 4th request in the same window must be blocked once maxRequests=3 is exceeded",
    );
    assert.equal(results[3].remaining, 0);
    assert.equal(results[0].remaining, 2, "remaining must count down from maxRequests - 1 after the first request");
  });

  it("tracks separate counters per identifier (no cross-user bleed)", async () => {
    const endpoint = "POST:/api/v1/orders";
    const config = { maxRequests: 1, windowMs: 60_000, redisClient: redis };
    const userA = uniqueId("user-a");
    const userB = uniqueId("user-b");

    const first = await checkRateLimit(userA, endpoint, config);
    const second = await checkRateLimit(userA, endpoint, config);
    const third = await checkRateLimit(userB, endpoint, config);

    assert.equal(first.allowed, true);
    assert.equal(second.allowed, false, "userA must be blocked on their 2nd request (limit=1)");
    assert.equal(third.allowed, true, "userB's own counter must be independent of userA's");
  });

  it("tracks separate counters per endpoint for the same identifier", async () => {
    const identifier = uniqueId("user");
    const config = { maxRequests: 1, windowMs: 60_000, redisClient: redis };

    const loginResult = await checkRateLimit(identifier, "POST:/api/v1/auth/login", config);
    const registerResult = await checkRateLimit(identifier, "POST:/api/v1/auth/register", config);

    assert.equal(loginResult.allowed, true);
    assert.equal(registerResult.allowed, true, "a different endpoint must not share the login endpoint's counter");
  });

  it("sets a TTL on the counter key so the window actually expires in Redis", async () => {
    const identifier = uniqueId("user");
    const endpoint = "POST:/api/v1/delegations";
    const windowMs = 60_000;

    await checkRateLimit(identifier, endpoint, { maxRequests: 5, windowMs, redisClient: redis });

    const windowKey = Math.floor(Date.now() / windowMs);
    const key = `ratelimit:${identifier}:${endpoint}:${windowKey}`;
    const ttl = await redis.ttl(key);

    assert.ok(ttl > 0, "the counter key must have a positive TTL so old windows are reclaimed automatically");
    assert.ok(ttl <= Math.ceil(windowMs / 1000), "TTL must not exceed the configured window");
  });

  it("resets the count once the fixed window rolls over", async () => {
    const identifier = uniqueId("user");
    const endpoint = "POST:/api/v1/delegations";
    // A short window makes this deterministic without mocking Date.now(): sleep past it and
    // read a real Redis key for the new window, proving the reset is a real key expiry/rollover
    // (a new windowKey => a fresh counter), not an assumption about in-process state.
    const windowMs = 1_000;
    const config = { maxRequests: 1, windowMs, redisClient: redis };

    const first = await checkRateLimit(identifier, endpoint, config);
    assert.equal(first.allowed, true);
    const second = await checkRateLimit(identifier, endpoint, config);
    assert.equal(second.allowed, false);

    await new Promise((resolve) => setTimeout(resolve, windowMs + 200));

    const third = await checkRateLimit(identifier, endpoint, config);
    assert.equal(third.allowed, true, "a new fixed window must start with a fresh counter");
  });
});

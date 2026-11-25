export * from "../src/routes/cart.js";
// Cart routes are implemented in ../src/routes/cart.js, which is backed by the
// CartRepository. In production the repository should be RedisCartRepository
// (apps/backend/gateway/src/services/redisCartRepository.ts) with TTL eviction,
// rather than InMemoryCartRepository.

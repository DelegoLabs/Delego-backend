import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SUBNET_VELOCITY_CONFIG,
  SubnetVelocityFilter,
  getSubnetForIp,
  requiresStepUpVerification,
  type SubnetVelocityRedisClient,
} from "./velocityFilter.js";

function createMockRedis(options?: {
  chaining?: boolean;
  initialCount?: number;
  isBlocked?: boolean;
  ttl?: number;
}): {
  client: SubnetVelocityRedisClient;
  multiSpies: {
    zadd: ReturnType<typeof vi.fn>;
    zremrangebyscore: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
  };
  setSpy: ReturnType<typeof vi.fn>;
  delSpy: ReturnType<typeof vi.fn>;
} {
  const chaining = options?.chaining ?? true;
  let count = options?.initialCount ?? 0;
  let blocked = options?.isBlocked ?? false;

  const multiObj: Record<string, ReturnType<typeof vi.fn>> = {};
  const zadd = vi.fn(() => {
    count += 1;
    return chaining ? multiObj : undefined;
  });
  const zremrangebyscore = vi.fn(() => (chaining ? multiObj : null));
  const expire = vi.fn(() => (chaining ? multiObj : "not-a-multi"));
  const exec = vi.fn(async () => []);

  multiObj.zadd = zadd;
  multiObj.zremrangebyscore = zremrangebyscore;
  multiObj.expire = expire;
  multiObj.exec = exec;

  const setSpy = vi.fn(async () => {
    blocked = true;
    return "OK" as const;
  });
  const delSpy = vi.fn(async () => {
    blocked = false;
    return 1;
  });

  const client: SubnetVelocityRedisClient = {
    multi: () => ({
      zadd,
      zremrangebyscore,
      expire,
      exec,
    }),
    zcount: vi.fn(async () => count),
    zremrangebyscore: vi.fn(async () => 0),
    set: setSpy,
    exists: vi.fn(async () => (blocked ? 1 : 0)),
    ttl: vi.fn(async () => options?.ttl ?? 600),
    del: delSpy,
  };

  return {
    client,
    multiSpies: { zadd, zremrangebyscore, expire, exec },
    setSpy,
    delSpy,
  };
}

describe("getSubnetForIp", () => {
  it("extracts /24 subnet for valid IPv4 addresses", () => {
    expect(getSubnetForIp("192.168.1.42")).toBe("192.168.1.0/24");
    expect(getSubnetForIp("  10.0.5.255  ")).toBe("10.0.5.0/24");
  });

  it("handles IPv4-mapped IPv6 addresses", () => {
    expect(getSubnetForIp("::ffff:203.0.113.17")).toBe("203.0.113.0/24");
  });

  it("extracts /48 subnet for full and compressed IPv6 addresses", () => {
    expect(getSubnetForIp("2001:db8:85a3:0:0:8a2e:370:7334")).toBe("2001:db8:85a3::/48");
    expect(getSubnetForIp("2001:db8:1::1")).toBe("2001:db8:1::/48");
    expect(getSubnetForIp("::1")).toBe("0:0:0::/48");
  });

  it("returns null for malformed or empty IP inputs", () => {
    expect(getSubnetForIp("")).toBeNull();
    expect(getSubnetForIp("   ")).toBeNull();
    expect(getSubnetForIp("not-an-ip")).toBeNull();
    expect(getSubnetForIp("999.999.999.999")).toBeNull();
    expect(getSubnetForIp("2001:db8:::1")).toBeNull();
  });
});

describe("SubnetVelocityFilter", () => {
  it("allows checkouts below the threshold and executes redis multi pipeline", async () => {
    const { client, multiSpies, setSpy } = createMockRedis({ chaining: true });
    const filter = new SubnetVelocityFilter(client, {
      maxCheckoutsPerSubnetPerMinute: 3,
      blockDurationSeconds: 300,
    });

    const result = await filter.recordAndCheck("198.51.100.12");

    expect(result).toEqual({
      blocked: false,
      subnet: "198.51.100.0/24",
      currentCount: 1,
    });
    expect(requiresStepUpVerification(result)).toBe(false);
    expect(multiSpies.zadd).toHaveBeenCalledTimes(1);
    expect(multiSpies.zremrangebyscore).toHaveBeenCalledTimes(1);
    expect(multiSpies.expire).toHaveBeenCalledTimes(1);
    expect(multiSpies.exec).toHaveBeenCalledTimes(1);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("handles non-chaining redis multi implementations safely", async () => {
    const { client, multiSpies } = createMockRedis({ chaining: false });
    const filter = new SubnetVelocityFilter(client);

    const result = await filter.recordAndCheck("198.51.100.99");

    expect(result.blocked).toBe(false);
    expect(result.subnet).toBe("198.51.100.0/24");
    expect(multiSpies.zadd).toHaveBeenCalledTimes(1);
    expect(multiSpies.zremrangebyscore).toHaveBeenCalledTimes(1);
    expect(multiSpies.expire).toHaveBeenCalledTimes(1);
    expect(multiSpies.exec).toHaveBeenCalledTimes(1);
  });

  it("blocks the subnet when checkout count exceeds the configured threshold", async () => {
    const { client, setSpy } = createMockRedis({ initialCount: 2 });
    const filter = new SubnetVelocityFilter(client, {
      maxCheckoutsPerSubnetPerMinute: 2,
      blockDurationSeconds: 900,
    });

    const result = await filter.recordAndCheck("198.51.100.50");

    expect(result).toEqual({
      blocked: true,
      subnet: "198.51.100.0/24",
      currentCount: 3,
      expiresInSeconds: 900,
    });
    expect(requiresStepUpVerification(result)).toBe(true);
    expect(setSpy).toHaveBeenCalledWith(
      "fraud:subnet-blocked:198.51.100.0/24",
      "1",
      "EX",
      900
    );
  });

  it("returns blocked immediately for an already-blocked subnet with remaining TTL", async () => {
    const { client, multiSpies } = createMockRedis({ isBlocked: true, ttl: 420 });
    const filter = new SubnetVelocityFilter(client);

    const result = await filter.recordAndCheck("198.51.100.77");

    expect(result).toEqual({
      blocked: true,
      subnet: "198.51.100.0/24",
      currentCount: DEFAULT_SUBNET_VELOCITY_CONFIG.maxCheckoutsPerSubnetPerMinute,
      expiresInSeconds: 420,
    });
    expect(multiSpies.exec).not.toHaveBeenCalled();
  });

  it("falls back to blockDurationSeconds when TTL is non-positive", async () => {
    const { client } = createMockRedis({ isBlocked: true, ttl: -1 });
    const filter = new SubnetVelocityFilter(client, { blockDurationSeconds: 120 });

    const result = await filter.recordAndCheck("198.51.100.77");

    expect(result.blocked).toBe(true);
    expect(result.expiresInSeconds).toBe(120);
  });

  it("fails open for malformed IP addresses without touching Redis", async () => {
    const { client, multiSpies } = createMockRedis();
    const filter = new SubnetVelocityFilter(client);

    const result = await filter.recordAndCheck("invalid-ip-address");

    expect(result).toEqual({
      blocked: false,
      subnet: "unknown",
      currentCount: 0,
    });
    expect(requiresStepUpVerification(result)).toBe(false);
    expect(multiSpies.exec).not.toHaveBeenCalled();
  });

  it("clears a subnet block via clearBlock", async () => {
    const { client, delSpy } = createMockRedis({ isBlocked: true });
    const filter = new SubnetVelocityFilter(client);

    await filter.clearBlock("198.51.100.0/24");

    expect(delSpy).toHaveBeenCalledWith("fraud:subnet-blocked:198.51.100.0/24");
  });
});

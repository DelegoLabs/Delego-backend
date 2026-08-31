import { describe, it, expect, beforeEach } from "vitest";
import { ClusterAwareRedisClient, getSlotForKey } from "./clusterClient.js";

describe("Issue #155 — ClusterAwareRedisClient", () => {
  let client: ClusterAwareRedisClient;

  beforeEach(() => {
    client = new ClusterAwareRedisClient();
  });

  it("calculates CRC16 slot and handles hash tags accurately", () => {
    const slot1 = getSlotForKey("user:100:profile");
    const slot2 = getSlotForKey("user:100:settings");
    const slotTagged1 = getSlotForKey("user:{100}:profile");
    const slotTagged2 = getSlotForKey("user:{100}:settings");

    expect(slot1).toBeGreaterThanOrEqual(0);
    expect(slot2).toBeGreaterThanOrEqual(0);
    expect(slot1).toBeLessThan(16384);
    expect(slot2).toBeLessThan(16384);
    expect(slotTagged1).toBe(slotTagged2); // Hash tags ensure co-location on same slot
  });

  it("routes write commands to master and reads to replicas with balancing", async () => {
    await client.set("account:999", "active");
    const val = await client.get("account:999");
    expect(val).toBe("active");

    const slot = getSlotForKey("account:999");
    const masterNode = client.getNodeForSlot(slot, false);
    const replicaNode = client.getNodeForSlot(slot, true);

    expect(masterNode.role).toBe("master");
    expect(replicaNode.role).toBe("replica");
  });

  it("handles failover by promoting replica to master and refreshing topology", () => {
    const metricsBefore = client.getMetrics();
    expect(metricsBefore.failovers).toBe(0);

    client.handleFailover("6379");

    const metricsAfter = client.getMetrics();
    expect(metricsAfter.failovers).toBe(1);

    const topology = client.getTopology();
    expect(topology.slots[0].master.port).toBe("6380"); // 6380 promoted
  });
});

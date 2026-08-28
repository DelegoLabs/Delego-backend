import { describe, it, expect, beforeEach } from "vitest";
import { TenantConnectionPoolManager } from "./tenantPoolManager.js";

describe("Issue #154 — TenantConnectionPoolManager", () => {
  let manager: TenantConnectionPoolManager;

  beforeEach(() => {
    manager = new TenantConnectionPoolManager();
  });

  it("registers tenants with tier-specific connection limits", () => {
    const freeConfig = manager.registerTenant({ tenantId: "t-free", tier: "free" });
    expect(freeConfig.maxConnections).toBe(2);
    expect(freeConfig.sharedPool).toBe(true);

    const entConfig = manager.registerTenant({ tenantId: "t-ent", tier: "enterprise" });
    expect(entConfig.maxConnections).toBe(50);
    expect(entConfig.sharedPool).toBe(false);
  });

  it("enforces connection quotas per tenant and throttles excess requests", async () => {
    manager.registerTenant({ tenantId: "t-1", tier: "free", maxConnections: 2 });

    const c1 = await manager.acquireConnection("t-1");
    const c2 = await manager.acquireConnection("t-1");

    expect(c1.inUse).toBe(true);
    expect(c2.inUse).toBe(true);

    await expect(manager.acquireConnection("t-1")).rejects.toThrow(
      /Connection quota exceeded for tenant t-1/
    );

    manager.releaseConnection(c1);
    const c3 = await manager.acquireConnection("t-1");
    expect(c3.inUse).toBe(true);
  });

  it("prevents cross-tenant query execution violations", () => {
    expect(manager.validateTenantQuery("tenant-a", "tenant-a")).toBe(true);

    expect(() => manager.validateTenantQuery("tenant-a", "tenant-b")).toThrow(
      /Access denied: Tenant tenant-a cannot execute queries on tenant tenant-b/
    );
  });

  it("migrates tenants between pools when upgrading tiers", async () => {
    manager.registerTenant({ tenantId: "t-grow", tier: "free" });
    const allocation = manager.migrateTenantPool("t-grow", "pro");

    expect(allocation.maxConnections).toBe(20);
    expect(allocation.poolId).toBe("pool-tenant-t-grow");
    expect(allocation.sharedWith).toHaveLength(0);
  });
});

/**
 * Issue #154 — Multi-tenant database connection pooling with isolation,
 * tier quotas, pool sharing, and cross-tenant query prevention.
 */

import { createLogger } from "../logger.js";

const log = createLogger("utils:tenant-pool", process.env.LOG_LEVEL ?? "info");

export type TenantTier = "free" | "starter" | "pro" | "enterprise";

export interface TenantPoolConfig {
  tenantId: string;
  tier: TenantTier;
  minConnections: number;
  maxConnections: number;
  sharedPool: boolean;
  priority: number; // 1 (low) to 10 (highest)
}

export interface TenantPoolMetrics {
  tenantId: string;
  poolName: string;
  activeConnections: number;
  idleConnections: number;
  waitingRequests: number;
  avgAcquireTimeMs: number;
  queriesPerSecond: number;
  quotaUtilization: number;
  throttledRequests: number;
}

export interface PoolAllocation {
  tenantId: string;
  poolId: string;
  allocatedConnections: number;
  maxConnections: number;
  sharedWith: string[];
}

export interface MockConnection {
  id: string;
  tenantId: string;
  poolId: string;
  inUse: boolean;
  lastUsedAt: number;
}

export class TenantConnectionPoolManager {
  private readonly configs = new Map<string, TenantPoolConfig>();
  private readonly metrics = new Map<string, TenantPoolMetrics>();
  private readonly connections = new Map<string, MockConnection[]>();
  private readonly sharedPools = new Map<string, string[]>(); // poolId -> tenantIds

  // Default tier limits
  private static readonly TIER_DEFAULTS: Record<
    TenantTier,
    { min: number; max: number; shared: boolean; priority: number }
  > = {
    free: { min: 0, max: 2, shared: true, priority: 1 },
    starter: { min: 1, max: 5, shared: true, priority: 3 },
    pro: { min: 2, max: 20, shared: false, priority: 7 },
    enterprise: { min: 5, max: 50, shared: false, priority: 10 },
  };

  /**
   * Registers a tenant and configures their connection pool.
   */
  registerTenant(config: Partial<TenantPoolConfig> & { tenantId: string; tier?: TenantTier }): TenantPoolConfig {
    const tier = config.tier ?? "free";
    const defaults = TenantConnectionPoolManager.TIER_DEFAULTS[tier];

    const fullConfig: TenantPoolConfig = {
      tenantId: config.tenantId,
      tier,
      minConnections: config.minConnections ?? defaults.min,
      maxConnections: config.maxConnections ?? defaults.max,
      sharedPool: config.sharedPool ?? defaults.shared,
      priority: config.priority ?? defaults.priority,
    };

    this.configs.set(config.tenantId, fullConfig);

    const poolName = fullConfig.sharedPool ? `shared-pool-${tier}` : `pool-tenant-${config.tenantId}`;
    this.metrics.set(config.tenantId, {
      tenantId: config.tenantId,
      poolName,
      activeConnections: 0,
      idleConnections: fullConfig.minConnections,
      waitingRequests: 0,
      avgAcquireTimeMs: 0,
      queriesPerSecond: 0,
      quotaUtilization: 0,
      throttledRequests: 0,
    });

    if (fullConfig.sharedPool) {
      const existing = this.sharedPools.get(poolName) ?? [];
      if (!existing.includes(config.tenantId)) {
        existing.push(config.tenantId);
        this.sharedPools.set(poolName, existing);
      }
    }

    log.info("Tenant connection pool registered", { tenantId: config.tenantId, tier, poolName });
    return fullConfig;
  }

  /**
   * Acquires a connection for a tenant, enforcing tier quotas and isolation.
   */
  async acquireConnection(tenantId: string): Promise<MockConnection> {
    const config = this.configs.get(tenantId);
    if (!config) {
      throw new Error(`Tenant ${tenantId} is not registered`);
    }

    const metric = this.metrics.get(tenantId)!;
    const poolId = config.sharedPool ? `shared-pool-${config.tier}` : `pool-tenant-${tenantId}`;

    let poolConns = this.connections.get(poolId);
    if (!poolConns) {
      poolConns = [];
      this.connections.set(poolId, poolConns);
    }

    const activeForTenant = poolConns.filter((c) => c.inUse && c.tenantId === tenantId).length;

    // Check quota
    if (activeForTenant >= config.maxConnections) {
      metric.throttledRequests++;
      log.warn("Tenant connection quota exceeded", { tenantId, active: activeForTenant, max: config.maxConnections });
      throw new Error(`Connection quota exceeded for tenant ${tenantId} (tier: ${config.tier}, max: ${config.maxConnections})`);
    }

    // Reuse idle or create new
    let conn = poolConns.find((c) => !c.inUse && (!c.tenantId || c.tenantId === tenantId));
    if (!conn) {
      conn = {
        id: `conn-${poolId}-${poolConns.length + 1}`,
        tenantId,
        poolId,
        inUse: true,
        lastUsedAt: Date.now(),
      };
      poolConns.push(conn);
    } else {
      conn.inUse = true;
      conn.tenantId = tenantId;
      conn.lastUsedAt = Date.now();
    }

    metric.activeConnections++;
    metric.idleConnections = Math.max(0, poolConns.filter((c) => !c.inUse).length);
    metric.quotaUtilization = metric.activeConnections / config.maxConnections;

    return conn;
  }

  /**
   * Releases a connection back to the pool.
   */
  releaseConnection(connection: MockConnection): void {
    connection.inUse = false;
    connection.lastUsedAt = Date.now();

    const metric = this.metrics.get(connection.tenantId);
    if (metric) {
      metric.activeConnections = Math.max(0, metric.activeConnections - 1);
      const config = this.configs.get(connection.tenantId);
      if (config) {
        metric.quotaUtilization = metric.activeConnections / config.maxConnections;
      }
    }
  }

  /**
   * Validates cross-tenant query boundary to prevent leakage.
   */
  validateTenantQuery(tenantId: string, queryTenantTarget: string): boolean {
    if (tenantId !== queryTenantTarget) {
      log.error("Cross-tenant query violation blocked", { tenantId, queryTenantTarget });
      throw new Error(`Access denied: Tenant ${tenantId} cannot execute queries on tenant ${queryTenantTarget}`);
    }
    return true;
  }

  /**
   * Migrates a tenant to a new tier and pool.
   */
  migrateTenantPool(tenantId: string, newTier: TenantTier): PoolAllocation {
    const oldConfig = this.configs.get(tenantId);
    if (!oldConfig) {
      throw new Error(`Tenant ${tenantId} not found for migration`);
    }

    // Register with new tier
    const updated = this.registerTenant({ tenantId, tier: newTier });
    const poolId = updated.sharedPool ? `shared-pool-${newTier}` : `pool-tenant-${tenantId}`;
    const sharedWith = updated.sharedPool ? (this.sharedPools.get(poolId) ?? []) : [];

    log.info("Tenant pool migrated successfully", { tenantId, from: oldConfig.tier, to: newTier });

    return {
      tenantId,
      poolId,
      allocatedConnections: updated.minConnections,
      maxConnections: updated.maxConnections,
      sharedWith,
    };
  }

  getMetrics(tenantId?: string): TenantPoolMetrics | TenantPoolMetrics[] {
    if (tenantId) {
      return (
        this.metrics.get(tenantId) ?? {
          tenantId,
          poolName: "unknown",
          activeConnections: 0,
          idleConnections: 0,
          waitingRequests: 0,
          avgAcquireTimeMs: 0,
          queriesPerSecond: 0,
          quotaUtilization: 0,
          throttledRequests: 0,
        }
      );
    }
    return [...this.metrics.values()];
  }
}

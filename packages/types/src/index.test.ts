import { describe, it, expect, expectTypeOf } from "vitest";
import { MerchantProfileUpdateSchema } from "@delegolabs/types";
import type {
  User,
  Delegation,
  SpendingPolicy,
  Order,
  WalletAccount,
  AgentDefinition,
  ApiResponse,
  HealthCheckResponse,
  LLMMessage,
  EmergencyBroadcastSignal,
} from "@delegolabs/types";

describe("@delegolabs/types", () => {
  it("exports the merchant profile schema used by the gateway", () => {
    expect(MerchantProfileUpdateSchema.parse({ displayName: "Acme" })).toEqual({
      displayName: "Acme",
    });
    expect(MerchantProfileUpdateSchema.safeParse({}).success).toBe(false);
    expect(MerchantProfileUpdateSchema.safeParse({ isVerified: true }).success).toBe(false);
  });

  it("exports the canonical agent chat and emergency broadcast types", () => {
    expectTypeOf<LLMMessage>().toEqualTypeOf<import("./llm.js").LLMMessage>();
    expectTypeOf<EmergencyBroadcastSignal>()
      .toEqualTypeOf<import("./security.js").EmergencyBroadcastSignal>();
  });

  it("exports User interface", () => {
    const user: User = {
      id: "u1",
      stellarAddress: "GABC",
      displayName: "Alice",
      email: "alice@example.com",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(user.id).toBe("u1");
  });

  it("exports Delegation with SpendingPolicy", () => {
    const policy: SpendingPolicy = {
      maxPerTransaction: 100n,
      maxTotal: 1000n,
      allowedMerchants: [],
      expiresAt: null,
    };
    const delegation: Delegation = {
      id: "d1",
      userId: "u1",
      agentId: "a1",
      status: "active",
      policy,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(delegation.status).toBe("active");
    expect(delegation.policy.maxPerTransaction).toBe(100n);
  });

  it("exports ApiResponse generic type", () => {
    const resp: ApiResponse<{ name: string }> = {
      data: { name: "test" },
      error: null,
    };
    expect(resp.data?.name).toBe("test");
  });

  it("exports HealthCheckResponse", () => {
    const health: HealthCheckResponse = {
      status: "ok",
      service: "types",
      version: "0.0.1",
      timestamp: new Date().toISOString(),
    };
    expect(health.status).toBe("ok");
  });

  it("exports WalletAccount type", () => {
    const acct: WalletAccount = {
      address: "GXYZ",
      network: "testnet",
    };
    expect(acct.network).toBe("testnet");
  });

  it("exports Order type", () => {
    const order: Order = {
      id: "o1",
      userId: "u1",
      delegationId: "d1",
      merchantId: "m1",
      status: "pending_approval",
      lineItems: [],
      totalStroops: "500",
      escrowContractId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(order.status).toBe("pending_approval");
  });

  it("exports AgentDefinition type", () => {
    const agent: AgentDefinition = {
      id: "a1",
      role: "buyer",
      name: "BuyerAgent",
      description: "Acts on behalf of buyer",
      version: "0.0.1",
    };
    expect(agent.role).toBe("buyer");
  });
});

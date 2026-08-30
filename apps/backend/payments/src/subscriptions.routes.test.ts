import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Route } from "@delegolabs/utils";
import { extractEscrowIdFromTx, submitContractInvocation } from "./escrowCoordinator/contractClient.js";
import { resetChargeStore } from "./subscriptions/chargeStore.js";
import { resetPlanStore } from "./subscriptions/planStore.js";
import { resetSubscriptionStore } from "./subscriptions/subscriptionStore.js";
import { registerRoutes } from "./routes.js";

vi.mock("./escrowCoordinator/contractClient.js", async () => {
  const actual = await vi.importActual<typeof import("./escrowCoordinator/contractClient.js")>(
    "./escrowCoordinator/contractClient.js"
  );
  return { ...actual, submitContractInvocation: vi.fn(), extractEscrowIdFromTx: vi.fn() };
});

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MERCHANT = "GMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM";
const BUYER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SELLER = "GSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS";
const TOKEN = "CTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT";

type MockResponse = ServerResponse & { statusCode: number; body: string };

function createMockReq(body: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = { "content-type": "application/json" };
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function createMockRes(): MockResponse {
  const res = {
    statusCode: 0,
    body: "",
    writeHead(status: number) {
      this.statusCode = status;
    },
    end(body?: string) {
      if (body !== undefined) this.body = body;
    },
  };
  return res as MockResponse;
}

function findRoute(method: string, path: string): Route {
  const route = registerRoutes().find((r) => r.method === method && r.pattern.test(path));
  if (!route) throw new Error(`Route not registered: ${method} ${path}`);
  return route;
}

describe("Subscription routes", () => {
  beforeEach(() => {
    process.env.ESCROW_CONTRACT_ID = CONTRACT_ID;
    resetPlanStore();
    resetSubscriptionStore();
    resetChargeStore();
    vi.mocked(submitContractInvocation).mockReset().mockResolvedValue({ hash: "tx", ledger: 1, success: true });
    vi.mocked(extractEscrowIdFromTx).mockReset().mockResolvedValue("7");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ESCROW_CONTRACT_ID;
  });

  async function createPlan(overrides: Record<string, unknown> = {}): Promise<string> {
    const route = findRoute("POST", "/subscriptions/plans");
    const res = createMockRes();
    await route.handler(
      createMockReq(
        JSON.stringify({
          merchantId: MERCHANT,
          name: "Pro",
          amount: "1000",
          currency: TOKEN,
          interval: "month",
          ...overrides,
        })
      ),
      res,
      {}
    );
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).data.id as string;
  }

  async function createSub(planId: string, overrides: Record<string, unknown> = {}): Promise<any> {
    const route = findRoute("POST", "/subscriptions");
    const res = createMockRes();
    await route.handler(
      createMockReq(
        JSON.stringify({
          planId,
          buyerAddress: BUYER,
          sellerAddress: SELLER,
          paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
          ...overrides,
        })
      ),
      res,
      {}
    );
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).data;
  }

  it("creates a plan and fetches it back", async () => {
    const planId = await createPlan();

    const getRoute = findRoute("GET", `/subscriptions/plans/${planId}`);
    const res = createMockRes();
    await getRoute.handler(createMockReq(""), res, { planId });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.name).toBe("Pro");
  });

  it("creates an active subscription (charging the first period) when the plan has no trial", async () => {
    const planId = await createPlan();
    const sub = await createSub(planId);

    expect(sub.status).toBe("active");
    expect(submitContractInvocation).toHaveBeenCalledWith(expect.objectContaining({ method: "deposit" }));
  });

  it("creates a trialing subscription with no charge when the plan has a trial", async () => {
    const planId = await createPlan({ trialDays: 14 });
    const sub = await createSub(planId);

    expect(sub.status).toBe("trialing");
    expect(submitContractInvocation).not.toHaveBeenCalled();
  });

  it("pauses, resumes, and cancels a subscription", async () => {
    const planId = await createPlan();
    const sub = await createSub(planId);

    const pauseRes = createMockRes();
    await findRoute("POST", `/subscriptions/${sub.id}/pause`).handler(createMockReq(""), pauseRes, {
      subscriptionId: sub.id,
    });
    expect(JSON.parse(pauseRes.body).data.status).toBe("paused");

    const resumeRes = createMockRes();
    await findRoute("POST", `/subscriptions/${sub.id}/resume`).handler(createMockReq(""), resumeRes, {
      subscriptionId: sub.id,
    });
    expect(JSON.parse(resumeRes.body).data.status).toBe("active");

    const cancelRes = createMockRes();
    await findRoute("POST", `/subscriptions/${sub.id}/cancel`).handler(createMockReq("{}"), cancelRes, {
      subscriptionId: sub.id,
    });
    expect(JSON.parse(cancelRes.body).data.status).toBe("cancelled");
  });

  it("forces a renewal via POST /subscriptions/:id/renew", async () => {
    const planId = await createPlan({ interval: "week" });
    const sub = await createSub(planId);

    const renewRes = createMockRes();
    await findRoute("POST", `/subscriptions/${sub.id}/renew`).handler(createMockReq("{}"), renewRes, {
      subscriptionId: sub.id,
    });

    expect(renewRes.statusCode).toBe(200);
    const renewed = JSON.parse(renewRes.body).data;
    expect(new Date(renewed.currentPeriodEnd).getTime()).toBeGreaterThan(new Date(sub.currentPeriodEnd).getTime());
  });

  it("changes plan via PATCH /subscriptions/:id/plan", async () => {
    const planA = await createPlan({ name: "A" });
    const planB = await createPlan({ name: "B", amount: "2000" });
    const sub = await createSub(planA);

    const res = createMockRes();
    await findRoute("PATCH", `/subscriptions/${sub.id}/plan`).handler(
      createMockReq(JSON.stringify({ planId: planB })),
      res,
      { subscriptionId: sub.id }
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.planId).toBe(planB);
  });

  it("returns 404 for an unknown subscription", async () => {
    const res = createMockRes();
    await findRoute("GET", "/subscriptions/does-not-exist").handler(createMockReq(""), res, {
      subscriptionId: "does-not-exist",
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("SUBSCRIPTION_NOT_FOUND");
  });

  it("returns 400 for an invalid create-plan request", async () => {
    const route = findRoute("POST", "/subscriptions/plans");
    const res = createMockRes();
    await route.handler(createMockReq(JSON.stringify({ name: "Missing fields" })), res, {});
    expect(res.statusCode).toBe(400);
  });
});

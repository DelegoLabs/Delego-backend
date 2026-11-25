import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { SLOManager } from "@delegolabs/utils";
import {
  sloDashboardHandler,
  getSLOManager,
  setSLOManager,
} from "../../../apps/backend/monitoring/src/routes.ts";
import { generateToken } from "../../../apps/backend/gateway/src/auth/authService.js";

function createAuthedRequest(headers = {}) {
  const token = generateToken({
    userId: "user_slo_test",
    email: "slo@example.com",
    roles: ["admin"],
  });
  const req = new Readable({
    read() {
      this.push(null);
    },
  });
  req.method = "GET";
  req.url = "/monitoring/slo/dashboard";
  req.headers = {
    host: "localhost",
    authorization: `Bearer ${token}`,
    ...headers,
  };
  return req;
}

function createUnauthedRequest() {
  const req = new Readable({
    read() {
      this.push(null);
    },
  });
  req.method = "GET";
  req.url = "/monitoring/slo/dashboard";
  req.headers = { host: "localhost" };
  return req;
}

function createResponse() {
  let raw = "";
  return {
    statusCode: 0,
    headers: {},
    body: null,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = { ...this.headers, ...headers };
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(data) {
      if (data) raw += data;
      this.body = raw ? JSON.parse(raw) : null;
    },
  };
}

describe("sloDashboardHandler", () => {
  const originalManager = getSLOManager();

  afterEach(() => {
    setSLOManager(originalManager);
  });

  it("returns 401 when unauthenticated", async () => {
    const req = createUnauthedRequest();
    const res = createResponse();

    await sloDashboardHandler(req, res);

    assert.equal(res.statusCode, 401);
  });

  it("aggregates healthy SLO state across registered services", async () => {
    const manager = new SLOManager(["gateway", "payments"]);
    manager.registerServiceSLOs("gateway");
    manager.registerServiceSLOs("payments");

    for (const slo of manager.listSLOs()) {
      manager.evaluateSLO(slo.id, 0.9999);
    }
    setSLOManager(manager);

    const req = createAuthedRequest();
    const res = createResponse();
    await sloDashboardHandler(req, res);

    assert.equal(res.statusCode, 200);
    const { data, error } = res.body;
    assert.equal(error, null);
    assert.equal(data.services.length, 2);

    const gateway = data.services.find((s) => s.name === "gateway");
    const payments = data.services.find((s) => s.name === "payments");
    assert.ok(gateway);
    assert.ok(payments);
    assert.equal(gateway.health, "healthy");
    assert.equal(payments.health, "healthy");
    assert.equal(gateway.incidents, 0);
    assert.equal(payments.incidents, 0);
    assert.equal(gateway.errorBudgetRemaining, 1);
    assert.equal(payments.errorBudgetRemaining, 1);

    assert.equal(data.summary.totalSLOs, gateway.slos + payments.slos);
    assert.equal(data.summary.healthy, data.summary.totalSLOs);
    assert.equal(data.summary.warning, 0);
    assert.equal(data.summary.critical, 0);
    assert.equal(data.summary.exhausted, 0);
    assert.equal(data.summary.activeIncidents, 0);
    assert.equal(data.summary.errorBudgetRemaining, 1);
    assert.equal(data.burnRateAlerts, 0);
    assert.equal(data.errorBudgetAlerts, 0);
    assert.ok(typeof data.lastUpdated === "string");
  });

  it("aggregates warning SLO state, error budget remaining, and active incidents", async () => {
    const manager = new SLOManager(["gateway", "payments"]);
    manager.registerServiceSLOs("gateway");
    manager.registerServiceSLOs("payments");

    const allSLOs = manager.listSLOs();
    for (const slo of allSLOs) {
      manager.evaluateSLO(slo.id, 0.9999);
    }

    const gatewaySLO = manager.listSLOs("gateway")[0];
    assert.ok(gatewaySLO);

    // Simulate a warning budget state and active error budget warning alert
    const origGetBudgetState = manager.getBudgetState.bind(manager);
    manager.getBudgetState = (sloId) => {
      const state = origGetBudgetState(sloId);
      if (sloId === gatewaySLO.id && state) {
        return {
          ...state,
          consumed: state.budget * 0.35,
          remaining: state.budget * 0.65,
          status: {
            ...state.status,
            current: "warning",
          },
        };
      }
      return state;
    };

    const origGetAlerts = manager.getAlerts.bind(manager);
    manager.getAlerts = (sloId) => {
      if (sloId === gatewaySLO.id) {
        return [
          {
            id: "alert_warn_1",
            sloId: gatewaySLO.id,
            service: "gateway",
            type: "error_budget_warning",
            severity: "warning",
            message: "Error budget consumption elevated",
            active: true,
            createdAt: new Date().toISOString(),
            metadata: {},
          },
        ];
      }
      return origGetAlerts(sloId);
    };

    setSLOManager(manager);

    const req = createAuthedRequest();
    const res = createResponse();
    await sloDashboardHandler(req, res);

    assert.equal(res.statusCode, 200);
    const { data } = res.body;

    const gateway = data.services.find((s) => s.name === "gateway");
    const payments = data.services.find((s) => s.name === "payments");
    assert.equal(gateway.health, "warning");
    assert.equal(gateway.incidents, 1);
    assert.ok(gateway.errorBudgetRemaining < 1);
    assert.equal(payments.health, "healthy");

    assert.equal(data.summary.warning, 1);
    assert.equal(data.summary.exhausted, 0);
    assert.equal(data.summary.activeIncidents, 1);
    assert.equal(data.errorBudgetAlerts, 1);
    assert.ok(data.summary.errorBudgetRemaining < 1);
  });

  it("aggregates exhausted SLO state with burn rate and error budget alerts", async () => {
    const manager = new SLOManager(["gateway", "payments"]);
    manager.registerServiceSLOs("gateway");
    manager.registerServiceSLOs("payments");

    for (const slo of manager.listSLOs("gateway")) {
      manager.evaluateSLO(slo.id, 0.9999);
    }
    const paymentSLOs = manager.listSLOs("payments");
    assert.ok(paymentSLOs.length > 0);
    // Evaluate first payments SLO well below target to exhaust error budget
    manager.evaluateSLO(paymentSLOs[0].id, 0.9);
    for (let i = 1; i < paymentSLOs.length; i++) {
      manager.evaluateSLO(paymentSLOs[i].id, 0.9999);
    }

    setSLOManager(manager);

    const req = createAuthedRequest();
    const res = createResponse();
    await sloDashboardHandler(req, res);

    assert.equal(res.statusCode, 200);
    const { data } = res.body;

    const gateway = data.services.find((s) => s.name === "gateway");
    const payments = data.services.find((s) => s.name === "payments");
    assert.equal(gateway.health, "healthy");
    assert.equal(payments.health, "exhausted");
    assert.ok(payments.incidents > 0);
    assert.ok(payments.errorBudgetRemaining < 1);

    assert.equal(data.summary.exhausted, 1);
    assert.equal(data.summary.healthy, data.summary.totalSLOs - 1);
    assert.ok(data.summary.activeIncidents > 0);
    assert.ok(data.burnRateAlerts > 0);
    assert.ok(data.errorBudgetAlerts > 0);
    assert.ok(data.summary.errorBudgetRemaining < 1);
  });
});

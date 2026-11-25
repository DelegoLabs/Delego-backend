import { beforeEach, describe, expect, it } from "vitest";
import {
  resetWorkflowTransitionAuditStore,
  setWorkflowTransitionAuditStore,
  snapshotWorkflowTransitionAudit,
} from "../../state/workflow-transition-audit.js";
import {
  getServiceEventOutboxStore,
  resetServiceEventOutboxStore,
} from "../../src/events/service-event-outbox.js";
import {
  deliveryWorkflow,
} from "./index.js";

function outboxRows() {
  const store = getServiceEventOutboxStore();
  if (!("snapshot" in store) || typeof store.snapshot !== "function") {
    throw new Error("Expected the in-memory service event outbox store in tests");
  }
  return store.snapshot();
}

describe("deliveryWorkflow", () => {
  beforeEach(() => {
    resetWorkflowTransitionAuditStore();
    resetServiceEventOutboxStore();
  });

  it("audits shipment and carrier transitions through in_transit", async () => {
    const first = await deliveryWorkflow({
      orderId: "order-1",
      event: { type: "shipment_created" },
    });
    const second = await deliveryWorkflow({
      orderId: "order-1",
      currentState: first.status,
      event: { type: "carrier_update", status: "in_transit" },
    });

    expect(second.status).toBe("in_transit");
    expect(snapshotWorkflowTransitionAudit().map(({ fromState, toState }) => [fromState, toState]))
      .toEqual([
        ["pending", "shipped"],
        ["shipped", "in_transit"],
      ]);
    expect(outboxRows()).toHaveLength(0);
  });

  it("requests escrow auto-release after delivery confirmation", async () => {
    const result = await deliveryWorkflow({
      orderId: "order-2",
      currentState: "in_transit",
      event: { type: "delivery_confirmed" },
    });

    expect(result.status).toBe("delivered");
    expect(outboxRows()).toEqual([
      expect.objectContaining({
        topic: "escrow:auto_release",
        payload: {
          type: "ESCROW_AUTO_RELEASE_REQUESTED",
          orderId: "order-2",
          deliveryStatus: "delivered",
        },
      }),
    ]);
  });

  it("requests a dispute when the carrier reports an exception", async () => {
    const result = await deliveryWorkflow({
      orderId: "order-3",
      currentState: "in_transit",
      event: { type: "carrier_update", status: "exception", details: "Package damaged" },
    });

    expect(result.status).toBe("exception");
    expect(outboxRows()).toEqual([
      expect.objectContaining({
        topic: "delivery:dispute_requested",
        payload: {
          type: "DELIVERY_DISPUTE_REQUESTED",
          orderId: "order-3",
          deliveryStatus: "exception",
          details: "Package damaged",
        },
      }),
    ]);
  });

  it("does not audit or notify for repeated in-transit updates", async () => {
    await deliveryWorkflow({
      orderId: "order-4",
      currentState: "in_transit",
      event: { type: "carrier_update", status: "in_transit" },
    });

    expect(snapshotWorkflowTransitionAudit()).toHaveLength(0);
    expect(outboxRows()).toHaveLength(0);
  });

  it("rejects out-of-order transitions without writing an audit row", async () => {
    await expect(
      deliveryWorkflow({
        orderId: "order-5",
        currentState: "shipped",
        event: { type: "delivery_confirmed" },
      })
    ).rejects.toThrow("Invalid delivery transition");

    expect(snapshotWorkflowTransitionAudit()).toHaveLength(0);
  });

  it("surfaces audit persistence failures instead of advancing the workflow", async () => {
    const failingStore = {
      insert: async () => {
        throw new Error("audit unavailable");
      },
    };
    setWorkflowTransitionAuditStore(failingStore);

    await expect(
      deliveryWorkflow({
        orderId: "order-6",
        event: { type: "shipment_created" },
      })
    ).rejects.toThrow("audit unavailable");
    expect(outboxRows()).toHaveLength(0);
  });
});

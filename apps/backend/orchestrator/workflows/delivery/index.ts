import { insertServiceEventOutbox } from "../../src/events/service-event-outbox.js";
import { insertWorkflowTransitionAudit } from "../../state/workflow-transition-audit.js";

export type DeliveryState = "pending" | "shipped" | "in_transit" | "delivered" | "exception";

export type DeliveryWorkflowEvent =
  | { type: "shipment_created" }
  | { type: "carrier_update"; status: "in_transit" | "delivered" | "exception"; details?: string }
  | { type: "delivery_confirmed" };

export interface DeliveryWorkflowInput {
  orderId: string;
  event: DeliveryWorkflowEvent;
  /** Current state from the order/workflow record. Defaults to `pending` for a new shipment. */
  currentState?: DeliveryState;
}

export interface DeliveryWorkflowResult {
  status: DeliveryState;
}

function nextDeliveryState(
  currentState: DeliveryState,
  event: DeliveryWorkflowEvent
): DeliveryState {
  if (currentState === "pending" && event.type === "shipment_created") {
    return "shipped";
  }
  if (
    currentState === "shipped" &&
    event.type === "carrier_update" &&
    event.status === "in_transit"
  ) {
    return "in_transit";
  }
  if (
    currentState === "in_transit" &&
    event.type === "carrier_update" &&
    event.status === "in_transit"
  ) {
    return "in_transit";
  }
  if (
    currentState === "in_transit" &&
    (event.type === "delivery_confirmed" ||
      (event.type === "carrier_update" && event.status === "delivered"))
  ) {
    return "delivered";
  }
  if (
    currentState === "in_transit" &&
    event.type === "carrier_update" &&
    event.status === "exception"
  ) {
    return "exception";
  }

  throw new Error(`Invalid delivery transition: ${event.type} from ${currentState}`);
}

function auditEventType(event: DeliveryWorkflowEvent): string {
  switch (event.type) {
    case "shipment_created":
      return "delivery_shipment_created";
    case "delivery_confirmed":
      return "delivery_confirmed";
    case "carrier_update":
      return `delivery_carrier_${event.status}`;
  }
}

export async function deliveryWorkflow(
  input: DeliveryWorkflowInput
): Promise<DeliveryWorkflowResult> {
  if (!input.orderId || input.orderId.trim() === "") {
    throw new Error("orderId is required");
  }

  const fromState = input.currentState ?? "pending";
  const toState = nextDeliveryState(fromState, input.event);

  if (fromState === toState) {
    return { status: toState };
  }

  await insertWorkflowTransitionAudit({
    orderId: input.orderId,
    fromState,
    toState,
    eventType: auditEventType(input.event),
  });

  if (toState === "delivered") {
    await insertServiceEventOutbox({
      topic: "escrow:auto_release",
      payload: {
        type: "ESCROW_AUTO_RELEASE_REQUESTED",
        orderId: input.orderId,
        deliveryStatus: toState,
      },
    });
  } else if (toState === "exception") {
    await insertServiceEventOutbox({
      topic: "delivery:dispute_requested",
      payload: {
        type: "DELIVERY_DISPUTE_REQUESTED",
        orderId: input.orderId,
        deliveryStatus: toState,
        ...(input.event.type === "carrier_update" && input.event.details
          ? { details: input.event.details }
          : {}),
      },
    });
  }

  return { status: toState };
}

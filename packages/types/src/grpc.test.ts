import { describe, it, expect } from "vitest";
import { validateProtobufServiceSchema, type ProtobufServiceSchema } from "./grpc.js";

function buildSchema(overrides: Partial<ProtobufServiceSchema> = {}): ProtobufServiceSchema {
  return {
    package: "delego.orders.v1",
    service: "OrderService",
    rpcs: [{ name: "GetOrder", input: "GetOrderRequest", output: "Order", streaming: "unary" }],
    options: {},
    ...overrides,
  };
}

describe("validateProtobufServiceSchema", () => {
  it("returns no errors for a valid schema", () => {
    expect(validateProtobufServiceSchema(buildSchema())).toEqual([]);
  });

  it("flags a schema with no RPCs", () => {
    const errors = validateProtobufServiceSchema(buildSchema({ rpcs: [] }));
    expect(errors).toContain("Service schema must declare at least one RPC");
  });

  it("flags duplicate RPC names within a service", () => {
    const errors = validateProtobufServiceSchema(
      buildSchema({
        rpcs: [
          { name: "GetOrder", input: "A", output: "B", streaming: "unary" },
          { name: "GetOrder", input: "C", output: "D", streaming: "unary" },
        ],
      }),
    );
    expect(errors).toContain("Duplicate RPC name: GetOrder");
  });

  it("allows multiple distinct RPCs with different streaming modes", () => {
    const errors = validateProtobufServiceSchema(
      buildSchema({
        rpcs: [
          { name: "GetOrder", input: "A", output: "B", streaming: "unary" },
          { name: "WatchOrders", input: "C", output: "D", streaming: "server" },
        ],
      }),
    );
    expect(errors).toEqual([]);
  });
});

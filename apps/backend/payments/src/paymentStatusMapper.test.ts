import { describe, expect, it } from "vitest";
import {
  mapContractStatusToPaymentStatus,
  type PaymentStatus,
} from "./paymentStatusMapper.js";

describe("mapContractStatusToPaymentStatus", () => {
  const expectedMappings: Array<[string, PaymentStatus]> = [
    ["initialized", "pending"],
    ["pending", "pending"],
    ["funded", "funded"],
    ["deposited", "funded"],
    ["released", "released"],
    ["completed", "released"],
    ["refunded", "refunded"],
    ["cancelled", "refunded"],
    ["disputed", "disputed"],
    ["in_dispute", "disputed"],
    ["failed", "failed"],
    ["error", "failed"],
    ["expired", "failed"],
  ];

  it.each(expectedMappings)(
    "maps contract status '%s' to '%s'",
    (contractStatus, expected) => {
      expect(mapContractStatusToPaymentStatus(contractStatus)).toBe(expected);
    }
  );

  it("normalizes uppercase and mixed-case statuses", () => {
    expect(mapContractStatusToPaymentStatus("INITIALIZED")).toBe("pending");
    expect(mapContractStatusToPaymentStatus("Funded")).toBe("funded");
    expect(mapContractStatusToPaymentStatus("DEPOSITED")).toBe("funded");
    expect(mapContractStatusToPaymentStatus("Completed")).toBe("released");
    expect(mapContractStatusToPaymentStatus("CANCELLED")).toBe("refunded");
    expect(mapContractStatusToPaymentStatus("In_Dispute")).toBe("disputed");
    expect(mapContractStatusToPaymentStatus("EXPIRED")).toBe("failed");
  });

  it("trims leading and trailing whitespace", () => {
    expect(mapContractStatusToPaymentStatus("  funded  ")).toBe("funded");
    expect(mapContractStatusToPaymentStatus("\treleased\n")).toBe("released");
    expect(mapContractStatusToPaymentStatus("  in_dispute\r\n")).toBe("disputed");
  });

  it("falls back to 'failed' for unknown or empty statuses", () => {
    expect(mapContractStatusToPaymentStatus("")).toBe("failed");
    expect(mapContractStatusToPaymentStatus("   ")).toBe("failed");
    expect(mapContractStatusToPaymentStatus("unknown")).toBe("failed");
    expect(mapContractStatusToPaymentStatus("processing")).toBe("failed");
    expect(mapContractStatusToPaymentStatus("in-dispute")).toBe("failed");
  });
});

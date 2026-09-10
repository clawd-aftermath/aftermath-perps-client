import type { SdkPerpetualsCancelAndPlaceOrdersInputs } from "aftermath-ts-sdk";
import { describe, expect, it } from "vitest";
import { planQuoteCycle, type QuoteCycleInput } from "../src/market-maker.js";

const base: QuoteCycleInput = {
  now: 1_000, quoteObservedAt: 999, marketId: "0xmarket", positionSize: "1",
  existingOrderIds: [9n], orderType: 2, hasPosition: true,
  desired: [
    { side: "buy", price: "10.00", size: "1.5", clientOrderId: 1n },
    { side: "sell", price: "10.10", size: "1.5", clientOrderId: 2n },
  ],
  limits: { tickSize: "0.01", lotSize: "0.1", maxOrders: 4, maxQuoteAgeMs: 500, maxAbsolutePosition: "5" },
};
const bid = { side: "buy" as const, price: "10.00", size: "1.5", clientOrderId: 1n };
const ask = { side: "sell" as const, price: "10.10", size: "1.5", clientOrderId: 2n };

function reason(input: QuoteCycleInput): string {
  const result = planQuoteCycle(input);
  expect(result.action).toBe("halt");
  return result.action === "halt" ? result.reason : "";
}

describe("planQuoteCycle", () => {
  it("creates 1e9-scaled SDK-compatible atomic replacement inputs", () => {
    const result = planQuoteCycle(base);
    expect(result.action).toBe("replace");
    if (result.action === "replace") {
      const sdkInput: SdkPerpetualsCancelAndPlaceOrdersInputs = result.input;
      expect(sdkInput.ordersToPlace).toEqual([
        { side: 0, price: 10_000_000_000n, size: 1_500_000_000n, clientOrderId: 1n },
        { side: 1, price: 10_100_000_000n, size: 1_500_000_000n, clientOrderId: 2n },
      ]);
    }
  });

  it("halts on time and configuration failures", () => {
    expect(reason({ ...base, quoteObservedAt: 0 })).toBe("fair-price input is stale");
    expect(reason({ ...base, quoteObservedAt: 1_001 })).toBe("fair-price timestamp is in the future");
    expect(reason({ ...base, now: Number.NaN })).toContain("timestamps");
    expect(reason({ ...base, limits: { ...base.limits, maxOrders: Number.NaN } })).toContain("maxOrders");
    expect(reason({ ...base, desired: [] })).toBe("no replacement quotes");
    expect(reason({ ...base, desired: [...base.desired, ...base.desired, ...base.desired] })).toBe("replacement exceeds maxOrders");
  });

  it("halts on invalid quote and risk conditions", () => {
    expect(reason({ ...base, positionSize: "6" })).toBe("position limit reached");
    expect(reason({ ...base, positionSize: "1", hasPosition: false })).toContain("requires hasPosition");
    expect(reason({ ...base, positionSize: "4.9" })).toContain("worst-case fill");
    expect(reason({ ...base, desired: [{ ...bid, price: "10.20" }, ask] })).toContain("self-cross");
    expect(reason({ ...base, desired: [bid, { ...ask, clientOrderId: 1n }] })).toContain("duplicate");
    expect(reason({ ...base, desired: [{ ...bid, price: "10.005" }, ask] })).toContain("not aligned");
    expect(reason({ ...base, limits: { ...base.limits, tickSize: "0.0000000001" } })).toContain("1e9");
  });
});

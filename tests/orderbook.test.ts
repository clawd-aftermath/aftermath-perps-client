import { describe, expect, it } from "vitest";
import { simulateOrderbook } from "../src/orderbook.js";
import type { Orderbook } from "../src/types.js";

const book: Orderbook = {
  id: "sol",
  marketId: "sol",
  bids: [
    { price: "99", size: "1" },
    { price: "98.5", size: "2" },
  ],
  asks: [
    { price: "100", size: "1" },
    { price: "101", size: "2" },
  ],
  nonce: 1n,
  updatedAt: 1,
  raw: null,
};

describe("simulateOrderbook", () => {
  it("calculates exact best, average, notional, and slippage for base input", () => {
    const result = simulateOrderbook(book, {
      side: "buy",
      input: "base",
      amount: "2",
    });

    expect(result).toMatchObject({
      requestedInputAmount: "2",
      fillableInputAmount: "2",
      unfilledInputAmount: "0",
      filledBaseAmount: "2",
      unfilledBaseAmount: "0",
      filledQuoteNotional: "201",
      unfilledQuoteNotional: null,
      bestExecutionPrice: "100",
      averageExecutionPrice: "100.5",
      slippagePercent: "0.5",
      fullyFillable: true,
    });
    expect(result.fills).toEqual([
      { price: "100", baseAmount: "1", quoteNotional: "100" },
      { price: "101", baseAmount: "1", quoteNotional: "101" },
    ]);
  });

  it("supports quote-notional input with a deterministic zero residual", () => {
    const result = simulateOrderbook(book, {
      side: "buy",
      input: "quote",
      amount: "150",
    });

    expect(result.filledQuoteNotional).toBe("150");
    expect(result.filledBaseAmount).toMatch(/^1\.49504950495049/);
    expect(result.unfilledInputAmount).toBe("0");
    expect(result.unfilledQuoteNotional).toBe("0");
    expect(result.fullyFillable).toBe(true);
  });

  it("returns a first-class partial fill with unfilled base", () => {
    const result = simulateOrderbook(book, {
      side: "buy",
      input: "base",
      amount: "5",
    });

    expect(result.filledBaseAmount).toBe("3");
    expect(result.filledQuoteNotional).toBe("302");
    expect(result.unfilledInputAmount).toBe("2");
    expect(result.unfilledBaseAmount).toBe("2");
    expect(result.fullyFillable).toBe(false);
  });

  it("respects a price limit and walks bids in descending order for sells", () => {
    const limitedBuy = simulateOrderbook(book, {
      side: "buy",
      input: "base",
      amount: "2",
      limitPrice: "100.5",
    });
    expect(limitedBuy.filledBaseAmount).toBe("1");
    expect(limitedBuy.unfilledBaseAmount).toBe("1");

    const sell = simulateOrderbook(book, {
      side: "sell",
      input: "base",
      amount: "2",
    });
    expect(sell.bestExecutionPrice).toBe("99");
    expect(sell.averageExecutionPrice).toBe("98.75");
    expect(Number(sell.slippagePercent)).toBeCloseTo(0.2525252525, 10);
  });

  it("rejects invalid amounts and invalid levels", () => {
    expect(() =>
      simulateOrderbook(book, { side: "buy", input: "base", amount: "0" }),
    ).toThrow("amount must be greater than zero");

    expect(() =>
      simulateOrderbook(
        { ...book, asks: [{ price: "100", size: "-1" }] },
        { side: "buy", input: "base", amount: "1" },
      ),
    ).toThrow("level.size must be greater than or equal to zero");
  });
});

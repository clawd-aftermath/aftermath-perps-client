import { describe, expect, it } from "vitest";
import { createBackendPreviewAdapter, previewOrder } from "../src/preview.js";
import type { Orderbook } from "../src/types.js";

const orderbook: Orderbook = {
  id: "market",
  marketId: "market",
  bids: [],
  asks: [{ price: "10", size: "2" }],
  nonce: 1n,
  updatedAt: 1,
  raw: null,
};

describe("backend preview boundary", () => {
  it("treats a 200-style { error } payload as an authoritative failure", async () => {
    const adapter = createBackendPreviewAdapter(async () => ({ error: "insufficient collateral" }));
    await expect(adapter.preview({})).resolves.toMatchObject({
      source: "authoritative-backend-preview",
      status: "error",
      error: "insufficient collateral",
    });
  });

  it("labels local execution separately from authoritative risk fields", async () => {
    const backend = createBackendPreviewAdapter(async () => ({ valid: true, margin: "4" }));
    const result = await previewOrder({
      orderbook,
      localRequest: { side: "buy", input: "base", amount: "1" },
      backendRequest: { accountId: 7n },
      backend,
    });

    expect(result.local.source).toBe("local-orderbook-estimate");
    expect(result.authoritative.status).toBe("success");
    expect(result.authority).toEqual({
      executionEstimate: "local",
      margin: "backend",
      collateral: "backend",
      liquidation: "backend",
      validity: "backend",
    });
  });
});

import type { PerpetualsAccount } from "aftermath-ts-sdk";
import { describe, expect, it, vi } from "vitest";
import { createExecutionController } from "../src/execution.js";

function acceptsSdkAccount(account: PerpetualsAccount): void {
  createExecutionController(account, { execute: async () => ({ digest: "test" }) });
}
void acceptsSdkAccount;

const replacement = {
  marketId: "0x1",
  orderIdsToCancel: [1n],
  ordersToPlace: [],
  orderType: 2 as const,
  reduceOnly: false,
  hasPosition: false,
};

describe("execution controller", () => {
  it("preserves the entire built transaction including sponsorship", async () => {
    const built = { tx: "tx", sponsorSignature: "signature" };
    const getCancelAndPlaceOrdersTx = vi.fn(async () => built);
    const execute = vi.fn(async () => "digest");
    const controller = createExecutionController(
      { getCancelAndPlaceOrdersTx, getCancelOrdersTx: vi.fn() },
      { execute },
    );
    await expect(controller.replace(replacement)).resolves.toBe("digest");
    expect(execute).toHaveBeenCalledWith(built);
  });

  it("rejects concurrent account submissions", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const controller = createExecutionController(
      { getCancelAndPlaceOrdersTx: async () => ({ tx: "tx" }), getCancelOrdersTx: vi.fn() },
      { execute: async () => pending },
    );
    const first = controller.replace(replacement);
    await expect(controller.replace(replacement)).rejects.toThrow("already in flight");
    release();
    await first;
  });

  it("latches ambiguous submission failures until reconciliation", async () => {
    const controller = createExecutionController(
      { getCancelAndPlaceOrdersTx: async () => ({ tx: "tx" }), getCancelOrdersTx: vi.fn() },
      { execute: async () => { throw new Error("timeout"); } },
    );
    await expect(controller.replace(replacement)).rejects.toThrow("timeout");
    await expect(controller.replace(replacement)).rejects.toThrow("must be reconciled");
    controller.acknowledgeReconciled();
    expect(controller.needsReconciliation).toBe(false);
  });

  it("builds cancellation for exactly the authoritative order IDs supplied", async () => {
    const getCancelOrdersTx = vi.fn(async () => ({ tx: "cancel" }));
    const execute = vi.fn(async () => "digest");
    const controller = createExecutionController(
      { getCancelAndPlaceOrdersTx: vi.fn(), getCancelOrdersTx },
      { execute },
    );
    const input = { marketIdsToData: { "0x1": { orderIds: [4n, 5n], collateralChange: 12 } } };
    await controller.cancelOrders(input);
    expect(getCancelOrdersTx).toHaveBeenCalledWith(input);
    expect(execute).toHaveBeenCalledWith({ tx: "cancel" });
  });
});

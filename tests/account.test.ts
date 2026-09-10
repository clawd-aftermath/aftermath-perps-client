import { describe, expect, it, vi } from "vitest";
import {
  AFTERMATH_TERMS_AND_CONDITIONS,
  accountIdWire,
  authenticateAftermathTerms,
  createAuthenticatedUserSubscription,
  createDryRunExecutor,
  createPerpsActions,
  paginateCursor,
} from "../src/account.js";

describe("account helpers", () => {
  it("signs only the canonical terms message", async () => {
    const authenticate = vi.fn(async () => ({ bytes: "bytes", signature: "signature" }));
    await expect(authenticateAftermathTerms({ authenticate })).resolves.toEqual({ bytes: "bytes", signature: "signature" });
    expect(authenticate).toHaveBeenCalledWith(AFTERMATH_TERMS_AND_CONDITIONS);
  });

  it("serializes and validates account IDs", () => {
    expect(accountIdWire(42n)).toBe("42n");
    expect(() => accountIdWire(-1n)).toThrow("non-negative");
    expect(createAuthenticatedUserSubscription({ accountId: 42n, walletAddress: "0xwallet", authentication: { bytes: "bytes", signature: "signature" } })).toEqual({ user: { accountId: 42n, withStopOrders: { walletAddress: "0xwallet", bytes: "bytes", signature: "signature" } } });
  });

  it("paginates cursors and rejects cycles", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [1], nextCursor: "next", hasNextPage: true })
      .mockResolvedValueOnce({ items: [2], nextCursor: "next", hasNextPage: true });
    const pages = paginateCursor({ fetchPage });
    await expect(pages.next()).resolves.toMatchObject({ value: { items: [1] } });
    await expect(pages.next()).resolves.toMatchObject({ value: { items: [2] } });
    await expect(pages.next()).rejects.toThrow("cycle");
  });

  it("preserves the complete sponsored envelope and prevents overlap", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async (built: { tx: string; sponsorSignature?: string }) => {
      await wait;
      return built.sponsorSignature;
    });
    const actions = createPerpsActions(
      { build: async () => ({ tx: "tx", sponsorSignature: "sponsor" }) },
      { execute },
      { preview: async <T>(_action: string, input: unknown) => ({ source: "authoritative-backend-preview" as const, status: "success" as const, data: input as T, raw: input }) },
    );
    const pending = actions.execute("placeLimitOrder", {});
    await expect(actions.execute("cancelOrders", {})).rejects.toThrow("already in flight");
    release();
    await expect(pending).resolves.toBe("sponsor");
    expect(execute).toHaveBeenCalledWith({ tx: "tx", sponsorSignature: "sponsor" });
  });

  it("latches ambiguous execution failures until reconciliation", async () => {
    const actions = createPerpsActions(
      { build: async () => ({ tx: "tx" }) },
      { execute: async () => { throw new Error("unknown submission outcome"); } },
      { preview: async <T>(_action: string, input: unknown) => ({ source: "authoritative-backend-preview" as const, status: "success" as const, data: input as T, raw: input }) },
    );
    await expect(actions.execute("placeMarketOrder", {})).rejects.toThrow("unknown submission outcome");
    expect(actions.needsReconciliation).toBe(true);
    await expect(actions.execute("placeMarketOrder", {})).rejects.toThrow("must be reconciled");
    actions.acknowledgeReconciled();
    expect(actions.needsReconciliation).toBe(false);
  });

  it("dry-run executors never submit", async () => {
    await expect(createDryRunExecutor().execute({ tx: "tx" })).rejects.toThrow("not signed or submitted");
  });
});

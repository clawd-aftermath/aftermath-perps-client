import { describe, expect, it, vi } from "vitest";
import { subscribeWithSelector } from "../src/react.js";
import {
  selectAccountPositions,
  selectAccountStops,
  selectCandles,
  selectMarkets,
  selectVaults,
} from "../src/selectors.js";
import { createPerpsStore, emptyPerpsData } from "../src/store.js";
import type { Market, PerpsState } from "../src/types.js";

function market(symbol: string): Market {
  return {
    id: "m",
    symbol,
    displayName: "Market",
    collateralCoinType: "0xusdc",
    lotSize: null,
    tickSize: null,
    initialMarginRatio: null,
    maintenanceMarginRatio: null,
    raw: null,
  };
}

describe("React selector subscriptions", () => {
  it("notifies only when the selected reference changes", async () => {
    const store = createPerpsStore({
      snapshotSource: {
        fetchSnapshot: async () => ({
          data: {
            ...emptyPerpsData(),
            markets: { m: market("M") },
          },
        }),
      },
    });
    await store.start();

    const onChange = vi.fn();
    const unsubscribe = subscribeWithSelector(
      store,
      (state) => state.markets.m,
      onChange,
    );

    store.applyDelta({
      kind: "upsert",
      collection: "prices",
      value: {
        id: "m",
        marketId: "m",
        indexPrice: "1",
        markPrice: "1",
        bookPrice: "1",
        midPrice: "1",
        collateralPrice: "1",
        updatedAt: null,
        raw: null,
      },
    });
    expect(onChange).not.toHaveBeenCalled();

    store.applyDelta({
      kind: "patch",
      collection: "markets",
      id: "m",
      value: { lotSize: "10" },
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("keeps collection and filtered selector results referentially stable", () => {
    const data = emptyPerpsData();
    const state = {
      ...data,
      markets: { m: market("M") },
      positions: {
        "a:m": {
          id: "a:m",
          accountId: "a",
          marketId: "m",
          side: "buy",
          size: "1",
          collateral: null,
          leverage: null,
          entryPrice: null,
          marginRatio: null,
          raw: null,
        },
      },
      connection: {
        status: "live",
        stale: false,
        generation: 1,
        reconnectCount: 0,
        snapshotAt: 1,
        error: null,
      },
    } satisfies PerpsState;

    const accountPositions = selectAccountPositions("a");
    expect(selectMarkets(state)).toBe(selectMarkets(state));
    expect(selectVaults(state)).toBe(selectVaults(state));
    expect(accountPositions(state)).toBe(accountPositions(state));

    const unrelatedState = {
      ...state,
      prices: {
        m: {
          id: "m",
          marketId: "m",
          indexPrice: "1",
          markPrice: "1",
          bookPrice: "1",
          midPrice: "1",
          collateralPrice: "1",
          updatedAt: null,
          raw: null,
        },
      },
    } satisfies PerpsState;
    expect(accountPositions(unrelatedState)).toBe(accountPositions(state));

    const accountStops = selectAccountStops("a");
    const candles = selectCandles("m", "1m");
    expect(accountStops(unrelatedState)).toBe(accountStops(state));
    expect(candles(unrelatedState)).toEqual([]);
  });
});

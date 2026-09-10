import { describe, expect, it, vi } from "vitest";
import {
  aftermathPost,
  createAftermathNativeSnapshotSource,
  createAftermathWebSocketStream,
  decodeAftermathMessage,
  type WebSocketLike,
} from "../src/aftermath.js";
import { createPerpsStore, emptyPerpsData } from "../src/store.js";
import type { StreamHandlers } from "../src/types.js";
import {
  checkedOracleWsMessage,
  checkedOrderbooksResponse,
  checkedOrderbookWsMessage,
} from "./fixtures/aftermath-5.0.2.js";

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(
    JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? `${item}n` : item,
    ),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
      ...init,
    },
  );
}

describe("Aftermath native adapter", () => {
  it("decodes authenticated user, order-history, and collateral-history payloads", () => {
    const user = decodeAftermathMessage({
      user: {
        account: { accountId: 7n, positions: [], availableCollateral: 10, availableCollateralUsd: 10, totalEquityUsd: 11 },
        stopOrders: [{ objectId: "0xstop", marketId: "0xmarket", side: 0, size: 2n, nonSlTp: { stopIndexPrice: 3, reduceOnly: true, triggerIfGeStopIndexPrice: true, triggerPriceType: 0 } }],
        twapOrders: [{ twapOrderObjectId: "0xtwap", processedAmount: 2n, details: { marketId: "0xmarket", side: 1, size: 10n, expireTimestamp: 1000n } }],
      },
    });
    expect(user).toEqual(expect.arrayContaining([
      expect.objectContaining({ collection: "accounts", value: expect.objectContaining({ id: "7" }) }),
      expect.objectContaining({ collection: "stops", values: [expect.objectContaining({ id: "0xstop", triggerPrice: "3" })] }),
      expect.objectContaining({ collection: "twaps", values: [expect.objectContaining({ id: "0xtwap", remainingSize: "8" })] }),
    ]));

    const orders = decodeAftermathMessage({ userOrders: { accountId: 7n, orders: [
      { timestamp: 123, txDigest: "digest", marketId: "0xmarket", eventType: "FilledTakerOrder", side: 0, price: 2, size: 3, orderId: "9" },
      { timestamp: 123, txDigest: "digest", marketId: "0xmarket", eventType: "LiquidatedPosition", side: 0, price: 2, size: 3, pnl: -1 },
    ] } });
    expect(orders.map((delta) => delta.kind === "upsert" ? delta.collection : delta.kind)).toEqual(["history", "fills", "history"]);

    const collateral = decodeAftermathMessage({ userCollateralChanges: { accountId: 7n, collateralChanges: [{ timestamp: 124, txDigest: "digest2", marketId: "0xmarket", eventType: "SettledFunding", collateralChange: 5, collateralChangeUsd: 5 }] } });
    expect(collateral).toEqual([
      expect.objectContaining({ collection: "history", value: expect.objectContaining({ accountId: "7", type: "SettledFunding" }) }),
      expect.objectContaining({ collection: "fundingPayments", value: expect.objectContaining({ amount: "5" }) }),
    ]);

    expect(decodeAftermathMessage({ marketCandles: { marketId: "0xmarket", interval: "1m", lastCandle: { timestamp: 100, open: 1, high: 3, low: 0.5, close: 2, volume: 9 } } })).toEqual([
      expect.objectContaining({ collection: "candles", value: expect.objectContaining({ id: "0xmarket:1m:100", close: "2" }) }),
    ]);
  });

  it("maps checked SDK fixtures and correlates orderbooks positionally", async () => {
    const bodies: Record<string, unknown> = {};
    const headers: Record<string, Headers> = {};
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(input.toString()).pathname;
        bodies[path] =
          init?.body === undefined ? null : JSON.parse(String(init.body));
        headers[path] = new Headers(init?.headers);
        switch (path) {
          case "/api/perpetuals/all-markets":
            return json({
              markets: [
                {
                  objectId: "0xmarket",
                  collateralCoinType: "0xusdc",
                  marketParams: {
                    baseAssetSymbol: "SUI",
                    lotSize: "1000000n",
                    tickSize: "1000n",
                  },
                },
                {
                  objectId: "0xsecond",
                  collateralCoinType: "0xusdc",
                  marketParams: { baseAssetSymbol: "BTC" },
                },
              ],
            });
          case "/api/perpetuals/markets":
            return json({
              marketDatas: [
                {
                  market: {
                    objectId: "0xmarket",
                    collateralCoinType: "0xusdc",
                    estimatedFundingRate: 0.001,
                    nextFundingTimestampMs: 1_800_000_000_000n,
                    marketParams: {
                      baseAssetSymbol: "SUI",
                      lotSize: "1000000n",
                      tickSize: "1000n",
                      marginRatioInitial: 0.1,
                      marginRatioMaintenance: 0.05,
                    },
                    marketState: {
                      cumFundingRateLong: 0.2,
                      cumFundingRateShort: -0.3,
                      fundingLastUpdateTimestamp: 1_700_000_000_000,
                    },
                  },
                  metadata: {
                    symbol: "SUI-PERP",
                    displayName: "Sui Perpetual",
                  },
                },
                {
                  market: {
                    objectId: "0xsecond",
                    collateralCoinType: "0xusdc",
                    marketParams: { baseAssetSymbol: "BTC" },
                    marketState: {},
                  },
                  metadata: { symbol: "BTC-PERP" },
                },
              ],
            });
          case "/api/perpetuals/markets/prices":
            return json({
              marketsPrices: [
                {
                  marketId: "0xmarket",
                  basePrice: 2,
                  markPrice: 2.01,
                  midPrice: 2.005,
                  collateralPrice: 1,
                },
                {
                  marketId: "0xsecond",
                  basePrice: 100,
                  markPrice: 100,
                  midPrice: 100,
                  collateralPrice: 1,
                },
              ],
            });
          case "/api/perpetuals/markets/orderbooks":
            return json(checkedOrderbooksResponse);
          case "/api/perpetuals/accounts/positions":
            return json({
              accounts: [
                {
                  accountId: 7n,
                  availableCollateral: 80,
                  availableCollateralUsd: 80,
                  totalEquityUsd: 125,
                  positions: [
                    {
                      marketId: "0xmarket",
                      baseAssetAmount: -0.5,
                      collateral: 20,
                      leverage: 2,
                      entryPrice: 2.2,
                      liquidationPrice: 4.5,
                      marginRatio: 0.2,
                      pendingOrders: [
                        {
                          orderId: 42n,
                          side: 1,
                          currentSize: 2n,
                          initialSize: 5n,
                          clientOrderId: 9n,
                        },
                      ],
                    },
                  ],
                },
              ],
            });
          case "/api/perpetuals/vaults":
            return json({
              vaults: [
                {
                  objectId: "0xvault",
                  accountId: 9n,
                  metadata: { name: "Alpha" },
                  collateralCoinType: "0xusdc",
                  lpCoinType: "0xlp",
                  tvlUsd: 500,
                  pausedUntilTimestamp: 1_900_000_000_000n,
                },
              ],
            });
          default:
            throw new Error(`Unexpected path ${path}`);
        }
      },
    );

    const source = createAftermathNativeSnapshotSource({
      baseUrl: "https://example.test",
      collateralCoinType: "0xusdc",
      accountIds: ["7"],
      fetch: fetcher,
    });
    const result = await source.fetchSnapshot(
      new AbortController().signal,
    );

    expect(bodies["/api/perpetuals/accounts/positions"]).toEqual({
      accountIds: ["7n"],
    });
    expect(
      headers["/api/perpetuals/markets/orderbooks"]?.get("Accept"),
    ).toBe("application/json");
    expect(result.data.orderbooks["0xmarket"]).toMatchObject({
      marketId: "0xmarket",
      nonce: 10n,
    });
    expect(result.data.orderbooks["0xsecond"]).toMatchObject({
      marketId: "0xsecond",
      nonce: 20n,
    });
    expect(result.data.positions["7:0xmarket"]).toMatchObject({
      side: "sell",
      size: "0.5",
    });
    expect(result.data.positions["7:0xmarket"]).not.toHaveProperty(
      "liquidationPrice",
    );
    expect(result.data.orders["42"]).toMatchObject({
      size: "5",
      filledSize: "3",
      status: "partially-filled",
      price: null,
    });
    expect(result.data.accounts["7"]).toMatchObject({
      availableCollateral: "80",
      availableCollateralUsd: "80",
      totalEquityUsd: "125",
    });
    expect(result.data.collateral["7"]).toMatchObject({
      available: "80",
      availableUsd: "80",
      totalEquityUsd: "125",
    });
    expect(result.data.funding["0xmarket"]).toMatchObject({
      cumulativeRateLong: "0.2",
      cumulativeRateShort: "-0.3",
    });
    expect(result.data.vaults["0xvault"]).toMatchObject({
      name: "Alpha",
      pausedUntilTimestamp: "1900000000000",
    });
  });

  it("validates account IDs and timeouts at construction", () => {
    expect(() =>
      createAftermathNativeSnapshotSource({
        collateralCoinType: "0xusdc",
        accountIds: ["0x7"],
      }),
    ).toThrow("unsigned base-10 integer string");
    expect(() =>
      createAftermathNativeSnapshotSource({
        collateralCoinType: "0xusdc",
        accountIds: [-1n],
      }),
    ).toThrow("non-negative");
    expect(() =>
      createAftermathNativeSnapshotSource({
        collateralCoinType: "0xusdc",
        timeoutMs: 0,
      }),
    ).toThrow("positive safe integer");
  });

  it("parses structured HTTP errors without assuming JSON success", async () => {
    const fetcher = vi.fn(async () =>
      json(
        { error_code: 2034, message: "invalid reusable signature" },
        { status: 400, headers: { "X-Error-Code": "2034" } },
      ),
    );
    await expect(
      aftermathPost(
        "https://example.test",
        "/api/perpetuals/account/previews/place-market-order",
        {},
        fetcher,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      status: 400,
      errorCode: "2034",
      message: "invalid reusable signature",
    });
  });

  it("aborts HTTP calls at the configured timeout", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init?.signal?.reason),
            { once: true },
          );
        }),
    );

    await expect(
      aftermathPost(
        "https://example.test",
        "/api/perpetuals/markets",
        {},
        fetcher,
        new AbortController().signal,
        1,
      ),
    ).rejects.toBeDefined();
  });

  it("merges WS market/oracle fields without clobbering REST metadata", async () => {
    const store = createPerpsStore({
      snapshotSource: {
        fetchSnapshot: async () => ({
          data: {
            ...emptyPerpsData(),
            markets: {
              "0xmarket": {
                id: "0xmarket",
                symbol: "SUI-PERP",
                displayName: "Sui Perpetual",
                collateralCoinType: "0xusdc",
                lotSize: "1",
                tickSize: "0.01",
                initialMarginRatio: "0.1",
                maintenanceMarginRatio: "0.05",
                raw: null,
              },
            },
            prices: {
              "0xmarket": {
                id: "0xmarket",
                marketId: "0xmarket",
                indexPrice: "2",
                markPrice: "2",
                bookPrice: null,
                midPrice: "2",
                collateralPrice: "1",
                updatedAt: null,
                raw: null,
              },
            },
            funding: {
              "0xmarket": {
                id: "0xmarket",
                marketId: "0xmarket",
                estimatedRate: "0.001",
                cumulativeRateLong: "0.2",
                cumulativeRateShort: "-0.2",
                nextFundingAt: 1,
                updatedAt: 1,
                raw: null,
              },
            },
          },
        }),
      },
    });
    await store.start();

    for (const delta of decodeAftermathMessage({
      market: {
        objectId: "0xmarket",
        collateralCoinType: "0xusdc",
        estimatedFundingRate: 0.002,
        nextFundingTimestampMs: 2n,
        marketState: {
          cumFundingRateLong: 0.3,
          cumFundingRateShort: -0.4,
          fundingLastUpdateTimestamp: 2,
        },
      },
    })) {
      store.applyDelta(delta);
    }
    for (const delta of decodeAftermathMessage(checkedOracleWsMessage)) {
      store.applyDelta(delta);
    }

    expect(store.getState().markets["0xmarket"]).toMatchObject({
      symbol: "SUI-PERP",
      displayName: "Sui Perpetual",
      lotSize: "1",
    });
    expect(store.getState().prices["0xmarket"]).toMatchObject({
      indexPrice: "2.02",
      markPrice: "2.03",
      bookPrice: "2.025",
      midPrice: "2",
    });
    expect(store.getState().funding["0xmarket"]).toMatchObject({
      estimatedRate: "0.002",
      cumulativeRateLong: "0.3",
      cumulativeRateShort: "-0.4",
      nextFundingAt: 2,
    });
  });

  it("decodes checked orderbook deltas, bigint nonce, and book price", () => {
    expect(decodeAftermathMessage(checkedOrderbookWsMessage)).toEqual([
      {
        kind: "orderbook",
        marketId: "0xmarket",
        bids: [{ price: "2", size: "5" }],
        asks: [{ price: "2.1", size: "0" }],
        replace: false,
        nonce: 11n,
        raw: checkedOrderbookWsMessage,
      },
    ]);

    expect(decodeAftermathMessage(checkedOracleWsMessage)).toMatchObject([
      {
        kind: "patch",
        collection: "prices",
        id: "0xmarket",
        value: {
          indexPrice: "2.02",
          markPrice: "2.03",
          bookPrice: "2.025",
        },
      },
    ]);
  });
});

class FakeSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];
  readonly close = vi.fn();

  send(data: string): void {
    this.sent.push(data);
  }
}

describe("Aftermath WebSocket transport", () => {
  it("sends supported subscribe frames and decodes string and ArrayBuffer messages", () => {
    const socket = new FakeSocket();
    const deltas: unknown[] = [];
    const handlers: StreamHandlers = {
      onOpen: vi.fn(),
      onDelta: (delta) => deltas.push(delta),
      onClose: vi.fn(),
      onError: vi.fn(),
    };
    createAftermathWebSocketStream({
      baseUrl: "https://example.test",
      subscriptions: [
        { market: { marketId: "0xmarket" } },
        { oracle: { marketId: "0xmarket" } },
        { orderbook: { marketId: "0xmarket" } },
      ],
      createWebSocket: () => socket,
    }).connect(handlers);

    socket.onopen?.({});
    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
      {
        action: "subscribe",
        subscriptionType: { market: { marketId: "0xmarket" } },
      },
      {
        action: "subscribe",
        subscriptionType: { oracle: { marketId: "0xmarket" } },
      },
      {
        action: "subscribe",
        subscriptionType: { orderbook: { marketId: "0xmarket" } },
      },
    ]);

    const wire = JSON.stringify(checkedOrderbookWsMessage, (_key, value) =>
      typeof value === "bigint" ? `${value}n` : value,
    );
    socket.onmessage?.({ data: wire });
    socket.onmessage?.({
      data: new TextEncoder().encode(wire).buffer as ArrayBuffer,
    });
    expect(deltas).toHaveLength(2);
    expect(deltas).toMatchObject([{ nonce: 11n }, { nonce: 11n }]);
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it("reports explicitly unhandled messages", () => {
    const socket = new FakeSocket();
    const onUnhandledMessage = vi.fn();
    createAftermathWebSocketStream({
      subscriptions: [],
      createWebSocket: () => socket,
      onUnhandledMessage,
    }).connect({
      onOpen: vi.fn(),
      onDelta: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    });

    socket.onmessage?.({ data: JSON.stringify({ marketOrders: [] }) });
    expect(onUnhandledMessage).toHaveBeenCalledWith({ marketOrders: [] });
  });
});

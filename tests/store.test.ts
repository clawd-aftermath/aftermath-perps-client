import { afterEach, describe, expect, it, vi } from "vitest";
import { createPerpsStore, emptyPerpsData } from "../src/store.js";
import type {
  DeltaStream,
  Market,
  Orderbook,
  PerpsSnapshot,
  SnapshotSource,
  StreamHandlers,
} from "../src/types.js";

function market(id: string, symbol: string): Market {
  return {
    id,
    symbol,
    displayName: symbol,
    collateralCoinType: null,
    lotSize: null,
    tickSize: null,
    initialMarginRatio: null,
    maintenanceMarginRatio: null,
    raw: null,
  };
}

function book(id: string, nonce: bigint): Orderbook {
  return {
    id,
    marketId: id,
    bids: [
      { price: "9", size: "1" },
      { price: "8", size: "2" },
    ],
    asks: [
      { price: "10", size: "1" },
      { price: "11", size: "2" },
    ],
    nonce,
    updatedAt: 1,
    raw: null,
  };
}

function snapshot(
  value: Market,
  books: Record<string, Orderbook> = {},
): PerpsSnapshot {
  return {
    data: {
      ...emptyPerpsData(),
      markets: { [value.id]: value },
      orderbooks: books,
    },
    receivedAt: 1,
  };
}

class FakeStream implements DeltaStream {
  readonly handlers: StreamHandlers[] = [];
  readonly closes: ReturnType<typeof vi.fn>[] = [];

  connect(handlers: StreamHandlers) {
    this.handlers.push(handlers);
    const close = vi.fn();
    this.closes.push(close);
    queueMicrotask(handlers.onOpen);
    return { close };
  }

  emit(index: number, delta: Parameters<StreamHandlers["onDelta"]>[0]) {
    this.handlers[index]?.onDelta(delta);
  }

  disconnect(index: number) {
    this.handlers[index]?.onClose("test disconnect");
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createPerpsStore orderbook semantics", () => {
  it("atomically replaces account-scoped collections and removes stale entities", async () => {
    const store = createPerpsStore({ snapshotSource: { fetchSnapshot: async () => ({ data: emptyPerpsData() }) } });
    await store.start();
    const position = (id: string, accountId: string) => ({ id, accountId, marketId: "m", side: "buy" as const, size: "1", collateral: null, leverage: null, entryPrice: null, marginRatio: null, raw: null });
    store.applyDelta({ kind: "replaceScope", collection: "positions", accountId: "a", values: [position("a:m", "a")] });
    store.applyDelta({ kind: "replaceScope", collection: "positions", accountId: "b", values: [position("b:m", "b")] });
    store.applyDelta({ kind: "replaceScope", collection: "positions", accountId: "a", values: [] });
    expect(store.getState().positions["a:m"]).toBeUndefined();
    expect(store.getState().positions["b:m"]).toBeDefined();
    store.stop();
  });

  it("merges incremental levels, removes zero sizes, and sorts canonically", async () => {
    const store = createPerpsStore({
      snapshotSource: {
        fetchSnapshot: async () =>
          snapshot(market("m", "M"), {
            m: {
              ...book("m", 10n),
              bids: [
                { price: "8", size: "2" },
                { price: "9", size: "1" },
              ],
              asks: [
                { price: "11", size: "2" },
                { price: "10", size: "1" },
              ],
            },
          }),
      },
    });
    await store.start();

    store.applyDelta({
      kind: "orderbook",
      marketId: "m",
      bids: [
        { price: "8", size: "0" },
        { price: "9.5", size: "3" },
      ],
      asks: [
        { price: "10", size: "0" },
        { price: "9.75", size: "4" },
      ],
      nonce: 11n,
    });

    expect(store.getState().orderbooks.m).toMatchObject({
      nonce: 11n,
      bids: [
        { price: "9.5", size: "3" },
        { price: "9", size: "1" },
      ],
      asks: [
        { price: "9.75", size: "4" },
        { price: "11", size: "2" },
      ],
    });
  });

  it("orders nonces independently per market", async () => {
    const store = createPerpsStore({
      snapshotSource: {
        fetchSnapshot: async () =>
          snapshot(market("m", "M"), {
            m: book("m", 10n),
            n: book("n", 100n),
          }),
      },
    });
    await store.start();

    store.applyDelta({
      kind: "orderbook",
      marketId: "n",
      bids: [{ price: "9", size: "3" }],
      nonce: 101n,
    });
    store.applyDelta({
      kind: "orderbook",
      marketId: "m",
      asks: [{ price: "10", size: "4" }],
      nonce: 11n,
    });

    expect(store.getState().orderbooks.m?.nonce).toBe(11n);
    expect(store.getState().orderbooks.n?.nonce).toBe(101n);
  });

  it("forces a resync when a live per-market nonce gap is observed", async () => {
    const stream = new FakeStream();
    const source: SnapshotSource = {
      fetchSnapshot: vi
        .fn<SnapshotSource["fetchSnapshot"]>()
        .mockResolvedValueOnce(snapshot(market("m", "FOUR"), { m: book("m", 4n) }))
        .mockResolvedValueOnce(snapshot(market("m", "SIX"), { m: book("m", 6n) })),
    };
    const store = createPerpsStore({ snapshotSource: source, stream });
    await store.start();

    stream.emit(0, {
      kind: "orderbook",
      marketId: "m",
      bids: [{ price: "9", size: "6" }],
      nonce: 6n,
    });
    await vi.waitFor(() => expect(source.fetchSnapshot).toHaveBeenCalledTimes(2));

    expect(store.getState().connection.status).toBe("live");
    expect(store.getState().markets.m?.symbol).toBe("SIX");
    expect(store.getState().orderbooks.m?.nonce).toBe(6n);
    store.stop();
  });
});

describe("createPerpsStore lifecycle", () => {
  it("requires a fresh snapshot after reconnect and drops stale buffered patches", async () => {
    vi.useFakeTimers();
    const stream = new FakeStream();
    let call = 0;
    let resolveReconnect!: (value: PerpsSnapshot) => void;
    const source: SnapshotSource = {
      fetchSnapshot: async () => {
        call += 1;
        if (call === 1) {
          return snapshot(market("m", "INITIAL"), { m: book("m", 10n) });
        }
        return new Promise<PerpsSnapshot>((resolve) => {
          resolveReconnect = resolve;
        });
      },
    };

    const store = createPerpsStore({
      snapshotSource: source,
      stream,
      reconnectDelayMs: () => 1,
    });
    await store.start();
    expect(store.getState().connection).toMatchObject({
      status: "live",
      stale: false,
    });

    stream.emit(0, {
      kind: "orderbook",
      marketId: "m",
      bids: [{ price: "9", size: "11" }],
      nonce: 11n,
    });
    stream.disconnect(0);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(stream.handlers).toHaveLength(2);
    expect(store.getState().connection.status).toBe("resyncing");

    stream.emit(1, {
      kind: "patch",
      collection: "markets",
      id: "m",
      value: { symbol: "UNSEQUENCED-STALE" },
    });
    stream.emit(1, {
      kind: "orderbook",
      marketId: "m",
      bids: [{ price: "9", size: "stale" }],
      nonce: 11n,
    });
    resolveReconnect(
      snapshot(market("m", "RESYNC"), { m: book("m", 20n) }),
    );
    await vi.waitFor(() =>
      expect(store.getState().connection.status).toBe("live"),
    );

    expect(store.getState().markets.m?.symbol).toBe("RESYNC");
    expect(store.getState().orderbooks.m?.nonce).toBe(20n);
    expect(store.getState().connection.reconnectCount).toBe(0);
    store.stop();
  });

  it("shares concurrent starts and supports REST-only operation", async () => {
    let resolveSnapshot!: (value: PerpsSnapshot) => void;
    const source: SnapshotSource = {
      fetchSnapshot: vi.fn(
        () =>
          new Promise<PerpsSnapshot>((resolve) => {
            resolveSnapshot = resolve;
          }),
      ),
    };
    const store = createPerpsStore({ snapshotSource: source });
    const first = store.start();
    const second = store.start();

    expect(first).toBe(second);
    expect(source.fetchSnapshot).toHaveBeenCalledTimes(1);
    resolveSnapshot(snapshot(market("m", "REST"), { m: book("m", 1n) }));
    await first;
    expect(store.getState().connection.status).toBe("live");
    store.stop();
  });

  it("stops a pending stream start deliberately without rejection", async () => {
    const stream: DeltaStream = {
      connect: vi.fn(() => ({ close: vi.fn() })),
    };
    const store = createPerpsStore({
      snapshotSource: {
        fetchSnapshot: vi.fn(),
      },
      stream,
    });
    const start = store.start();
    store.stop();

    await expect(start).resolves.toBeUndefined();
    expect(store.getState().connection.status).toBe("stopped");
  });

  it("rejects resync while stopped", async () => {
    const store = createPerpsStore({
      snapshotSource: {
        fetchSnapshot: async () => snapshot(market("m", "M")),
      },
    });
    await expect(store.resync()).rejects.toThrow(
      "Cannot resync a stopped store",
    );
  });

  it("isolates throwing subscribers", async () => {
    const onSubscriberError = vi.fn();
    const store = createPerpsStore({
      snapshotSource: {
        fetchSnapshot: async () => snapshot(market("m", "M")),
      },
      onSubscriberError,
    });
    const healthy = vi.fn();
    store.subscribe(() => {
      throw new Error("listener failed");
    });
    store.subscribe(healthy);

    await store.start();
    expect(healthy).toHaveBeenCalled();
    expect(onSubscriberError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "listener failed" }),
    );
  });

  it("bounds deltas buffered during resync", async () => {
    let resolveSnapshot!: (value: PerpsSnapshot) => void;
    const stream = new FakeStream();
    const store = createPerpsStore({
      snapshotSource: {
        fetchSnapshot: () =>
          new Promise<PerpsSnapshot>((resolve) => {
            resolveSnapshot = resolve;
          }),
      },
      stream,
      maxBufferedDeltas: 1,
    });
    const start = store.start();
    await Promise.resolve();
    await Promise.resolve();

    stream.emit(0, {
      kind: "orderbook",
      marketId: "m",
      bids: [],
      nonce: 1n,
    });
    stream.emit(0, {
      kind: "orderbook",
      marketId: "m",
      asks: [],
      nonce: 2n,
    });
    expect(store.getState().connection.error?.message).toContain(
      "buffer exceeded 1",
    );

    store.stop();
    resolveSnapshot(snapshot(market("m", "M"), { m: book("m", 2n) }));
    await expect(start).resolves.toBeUndefined();
  });
});

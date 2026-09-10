import { decimalString, nonNegativeDecimal, positiveDecimal } from "./decimal.js";
import type {
  DeltaStream,
  Orderbook,
  OrderbookLevel,
  PerpsData,
  PerpsDelta,
  PerpsState,
  PerpsStore,
  PerpsStoreOptions,
  StateListener,
  StreamConnection,
} from "./types.js";

export function emptyPerpsData(): PerpsData {
  return {
    markets: {},
    prices: {},
    orderbooks: {},
    accounts: {},
    positions: {},
    orders: {},
    collateral: {},
    funding: {},
    stops: {},
    twaps: {},
    fills: {},
    history: {},
    fundingPayments: {},
    candles: {},
    vaults: {},
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function mergeLevels(
  current: readonly OrderbookLevel[],
  updates: readonly OrderbookLevel[],
  descending: boolean,
): readonly OrderbookLevel[] {
  const byPrice = new Map(
    current.map((level) => [
      decimalString(positiveDecimal(level.price, "price")),
      level,
    ]),
  );

  for (const update of updates) {
    const price = decimalString(positiveDecimal(update.price, "price"));
    const size = nonNegativeDecimal(update.size, "size");
    if (size.isZero()) {
      byPrice.delete(price);
    } else {
      byPrice.set(price, { price, size: decimalString(size) });
    }
  }

  return [...byPrice.values()].sort((left, right) => {
    const comparison = positiveDecimal(left.price, "price").comparedTo(
      positiveDecimal(right.price, "price"),
    );
    return descending ? -comparison : comparison;
  });
}

export function createPerpsStore(options: PerpsStoreOptions): PerpsStore {
  const listeners = new Set<StateListener>();
  const reconnectDelay =
    options.reconnectDelayMs ??
    ((attempt) => Math.min(30_000, 500 * 2 ** attempt));
  const maxBufferedDeltas = options.maxBufferedDeltas ?? 1_000;
  if (!Number.isSafeInteger(maxBufferedDeltas) || maxBufferedDeltas <= 0) {
    throw new RangeError("maxBufferedDeltas must be a positive safe integer");
  }

  let state: PerpsState = {
    ...emptyPerpsData(),
    connection: {
      status: "idle",
      stale: true,
      generation: 0,
      reconnectCount: 0,
      snapshotAt: null,
      error: null,
    },
  };
  let stopped = true;
  let generation = 0;
  let connection: StreamConnection | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;
  let buffered: PerpsDelta[] = [];
  let synchronizeTask: { generation: number; promise: Promise<void> } | null = null;
  let startTask: Promise<void> | null = null;
  let readyResolve: (() => void) | null = null;

  const reportSubscriberError = (error: unknown): void => {
    try {
      options.onSubscriberError?.(error);
    } catch {
      // Subscriber error reporting must not break delivery to other listeners.
    }
  };

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        reportSubscriberError(error);
      }
    }
  };

  const updateConnection = (patch: Partial<PerpsState["connection"]>): void => {
    state = {
      ...state,
      connection: { ...state.connection, ...patch },
    };
    emit();
  };

  const applyInternal = (delta: PerpsDelta): "applied" | "stale" | "gap" => {
    if (delta.kind === "upsert") {
      const collection = delta.collection;
      const value = delta.value;
      const nextCollection = { ...state[collection], [value.id]: value };
      state = { ...state, [collection]: nextCollection } as PerpsState;
    } else if (delta.kind === "patch") {
      const collection = delta.collection;
      const current = state[collection][delta.id];
      if (current === undefined) {
        return "stale";
      }
      const nextCollection = {
        ...state[collection],
        [delta.id]: { ...current, ...delta.value, id: delta.id },
      };
      state = { ...state, [collection]: nextCollection } as PerpsState;
    } else if (delta.kind === "remove") {
      const collection = delta.collection;
      const nextCollection = { ...state[collection] } as Record<string, unknown>;
      delete nextCollection[delta.id];
      state = { ...state, [collection]: nextCollection } as PerpsState;
    } else if (delta.kind === "replaceScope") {
      const collection = delta.collection;
      const nextCollection = Object.fromEntries([
        ...Object.entries(state[collection]).filter(([, value]) => value.accountId !== delta.accountId),
        ...delta.values.map((value) => [value.id, value]),
      ]);
      state = { ...state, [collection]: nextCollection } as PerpsState;
    } else {
      const current = state.orderbooks[delta.marketId];
      if (current === undefined || current.nonce === null) {
        if (delta.replace !== true) {
          return "gap";
        }
      } else {
        if (delta.nonce <= current.nonce) {
          return "stale";
        }
        if (delta.replace !== true && delta.nonce > current.nonce + 1n) {
          return "gap";
        }
      }

      const replace = delta.replace ?? current === undefined;
      const bids = mergeLevels(
        replace ? [] : (current?.bids ?? []),
        delta.bids ?? [],
        true,
      );
      const asks = mergeLevels(
        replace ? [] : (current?.asks ?? []),
        delta.asks ?? [],
        false,
      );
      const orderbook: Orderbook = {
        id: delta.marketId,
        marketId: delta.marketId,
        bids,
        asks,
        nonce: delta.nonce,
        updatedAt: delta.receivedAt ?? Date.now(),
        raw: delta.raw ?? null,
      };
      state = {
        ...state,
        orderbooks: { ...state.orderbooks, [delta.marketId]: orderbook },
      };
    }

    emit();
    return "applied";
  };

  const replayBufferedOrderbooks = (): boolean => {
    while (buffered.length > 0) {
      const pending = buffered;
      buffered = [];
      const byMarket = new Map<string, Extract<PerpsDelta, { kind: "orderbook" }>[]>();
      for (const delta of pending) {
        if (delta.kind !== "orderbook") {
          continue;
        }
        const marketDeltas = byMarket.get(delta.marketId) ?? [];
        marketDeltas.push(delta);
        byMarket.set(delta.marketId, marketDeltas);
      }
      for (const marketDeltas of byMarket.values()) {
        marketDeltas.sort((left, right) =>
          left.nonce < right.nonce ? -1 : left.nonce > right.nonce ? 1 : 0,
        );
        for (const delta of marketDeltas) {
          if (applyInternal(delta) === "gap") {
            buffered = [];
            return false;
          }
        }
      }
    }
    return true;
  };

  const resolveReady = (): void => {
    readyResolve?.();
    readyResolve = null;
    startTask = null;
  };

  const trackStartTask = (task: Promise<void>): Promise<void> => {
    startTask = task;
    void task.then(
      () => {
        if (startTask === task) startTask = null;
      },
      () => {
        if (startTask === task) startTask = null;
      },
    );
    return task;
  };

  const synchronize = async (activeGeneration: number): Promise<void> => {
    if (synchronizeTask?.generation === activeGeneration) {
      return synchronizeTask.promise;
    }

    const run = async (): Promise<void> => {
      abortController?.abort();
      const controller = new AbortController();
      abortController = controller;
      updateConnection({
        status: "resyncing",
        stale: true,
        generation: activeGeneration,
        error: null,
      });

      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const snapshot = await options.snapshotSource.fetchSnapshot(controller.signal);
          if (stopped || activeGeneration !== generation) {
            return;
          }

          state = {
            ...snapshot.data,
            stops: state.stops,
            twaps: state.twaps,
            fills: state.fills,
            history: state.history,
            fundingPayments: state.fundingPayments,
            candles: state.candles,
            connection: {
              ...state.connection,
              status: "resyncing",
              stale: true,
              snapshotAt: snapshot.receivedAt ?? Date.now(),
              error: null,
            },
          };
          emit();

          if (replayBufferedOrderbooks()) {
            updateConnection({
              status: "live",
              stale: false,
              reconnectCount: 0,
              error: null,
            });
            resolveReady();
            return;
          }

          updateConnection({
            status: "resyncing",
            stale: true,
            error: new Error(
              "Per-market orderbook nonce gap detected; fetching a fresh snapshot",
            ),
          });
        }

        throw new Error(
          "Unable to establish contiguous orderbooks after two snapshots",
        );
      } catch (error) {
        if (stopped || activeGeneration !== generation) {
          return;
        }
        const normalized = toError(error);
        updateConnection({ status: "error", stale: true, error: normalized });
        throw normalized;
      } finally {
        if (abortController === controller) {
          abortController = null;
        }
      }
    };

    const promise = run().finally(() => {
      if (synchronizeTask?.promise === promise) {
        synchronizeTask = null;
      }
    });
    synchronizeTask = { generation: activeGeneration, promise };
    return promise;
  };

  const scheduleReconnect = (): void => {
    const stream = options.stream;
    if (stopped || stream === undefined || reconnectTimer !== null) {
      return;
    }
    const attempt = state.connection.reconnectCount + 1;
    updateConnection({
      status: "reconnecting",
      stale: true,
      reconnectCount: attempt,
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openStream(stream);
    }, reconnectDelay(attempt - 1));
  };

  const failBuffer = (): void => {
    buffered = [];
    const error = new Error(
      `Orderbook resync buffer exceeded ${maxBufferedDeltas} deltas`,
    );
    updateConnection({ status: "error", stale: true, error });
    abortController?.abort(error);
    connection?.close();
    scheduleReconnect();
  };

  const bufferDelta = (delta: PerpsDelta): boolean => {
    if (delta.kind !== "orderbook") {
      return true;
    }
    if (buffered.length >= maxBufferedDeltas) {
      failBuffer();
      return false;
    }
    buffered.push(delta);
    return true;
  };

  const beginResync = (activeGeneration: number): void => {
    // A completed synchronization can remain referenced until its `.finally()`
    // microtask runs. Once state is live there is no active snapshot to reuse,
    // so a nonce gap must always start a fresh synchronization.
    if (state.connection.status === "live") {
      synchronizeTask = null;
    }
    void synchronize(activeGeneration).catch(() => {
      if (stopped || activeGeneration !== generation) {
        return;
      }
      connection?.close();
      scheduleReconnect();
    });
  };

  const openStream = (stream: DeltaStream): void => {
    if (stopped) {
      return;
    }

    generation += 1;
    const activeGeneration = generation;
    buffered = [];
    updateConnection({
      status: state.connection.snapshotAt === null ? "connecting" : "reconnecting",
      stale: true,
      generation: activeGeneration,
    });

    try {
      connection = stream.connect({
        onOpen: () => {
          if (stopped || activeGeneration !== generation) {
            return;
          }
          beginResync(activeGeneration);
        },
        onDelta: (delta) => {
          if (stopped || activeGeneration !== generation) {
            return;
          }
          if (state.connection.status !== "live") {
            bufferDelta(delta);
            return;
          }
          if (applyInternal(delta) === "gap") {
            if (bufferDelta(delta)) {
              beginResync(activeGeneration);
            }
          }
        },
        onClose: () => {
          if (stopped || activeGeneration !== generation) {
            return;
          }
          abortController?.abort();
          updateConnection({ status: "reconnecting", stale: true });
          scheduleReconnect();
        },
        onError: (error) => {
          if (stopped || activeGeneration !== generation) {
            return;
          }
          updateConnection({ stale: true, error: toError(error) });
        },
      });
    } catch (error) {
      updateConnection({ status: "error", stale: true, error: toError(error) });
      scheduleReconnect();
    }
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => {
      if (!stopped) {
        if (state.connection.status === "live") {
          return Promise.resolve();
        }
        if (startTask !== null) {
          return startTask;
        }
      }

      stopped = false;
      if (options.stream === undefined) {
        generation += 1;
        return trackStartTask(synchronize(generation));
      }

      const ready = new Promise<void>((resolve) => {
        readyResolve = resolve;
      });
      trackStartTask(ready);
      openStream(options.stream);
      return ready;
    },
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      generation += 1;
      buffered = [];
      abortController?.abort();
      abortController = null;
      connection?.close();
      connection = null;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      resolveReady();
      updateConnection({ status: "stopped", stale: true, generation });
    },
    resync: async () => {
      if (stopped) {
        throw new Error("Cannot resync a stopped store; call start() first");
      }
      await synchronize(generation);
    },
    applyDelta: (delta) => {
      if (stopped) {
        return;
      }
      if (state.connection.status !== "live") {
        bufferDelta(delta);
        return;
      }
      if (applyInternal(delta) === "gap" && bufferDelta(delta)) {
        beginResync(generation);
      }
    },
  };
}

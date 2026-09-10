import type {
  Account,
  Candle,
  Funding,
  Market,
  MarketPrice,
  Order,
  Orderbook,
  PerpsState,
  Position,
  Vault,
} from "./types.js";

function memoizedValues<T>() {
  const cache = new WeakMap<object, readonly T[]>();
  return (source: Readonly<Record<string, T>>): readonly T[] => {
    const cached = cache.get(source);
    if (cached !== undefined) {
      return cached;
    }
    const result = Object.values(source);
    cache.set(source, result);
    return result;
  };
}

const marketValues = memoizedValues<Market>();
const vaultValues = memoizedValues<Vault>();

export const selectConnection = (
  state: PerpsState,
): PerpsState["connection"] => state.connection;

export const selectMarkets = (state: PerpsState): readonly Market[] =>
  marketValues(state.markets);

export const selectMarket =
  (marketId: string) =>
  (state: PerpsState): Market | null =>
    state.markets[marketId] ?? null;

export const selectMarketPrice =
  (marketId: string) =>
  (state: PerpsState): MarketPrice | null =>
    state.prices[marketId] ?? null;

export const selectOrderbook =
  (marketId: string) =>
  (state: PerpsState): Orderbook | null =>
    state.orderbooks[marketId] ?? null;

export const selectAccount =
  (accountId: string) =>
  (state: PerpsState): Account | null =>
    state.accounts[accountId] ?? null;

export const selectAccountPositions = (accountId: string) => {
  let previousSource: PerpsState["positions"] | null = null;
  let previousResult: readonly Position[] = [];
  return (state: PerpsState): readonly Position[] => {
    if (state.positions !== previousSource) {
      previousSource = state.positions;
      previousResult = Object.values(state.positions).filter(
        (position) => position.accountId === accountId,
      );
    }
    return previousResult;
  };
};

export const selectAccountOrders = (accountId: string) => {
  let previousSource: PerpsState["orders"] | null = null;
  let previousResult: readonly Order[] = [];
  return (state: PerpsState): readonly Order[] => {
    if (state.orders !== previousSource) {
      previousSource = state.orders;
      previousResult = Object.values(state.orders).filter(
        (order) => order.accountId === accountId,
      );
    }
    return previousResult;
  };
};

export const selectMarketOrders = (marketId: string) => {
  let previousSource: PerpsState["orders"] | null = null;
  let previousResult: readonly Order[] = [];
  return (state: PerpsState): readonly Order[] => {
    if (state.orders !== previousSource) {
      previousSource = state.orders;
      previousResult = Object.values(state.orders).filter(
        (order) => order.marketId === marketId,
      );
    }
    return previousResult;
  };
};

export const selectFunding =
  (marketId: string) =>
  (state: PerpsState): Funding | null =>
    state.funding[marketId] ?? null;

export const selectVaults = (state: PerpsState): readonly Vault[] =>
  vaultValues(state.vaults);

function accountValues<T extends { readonly accountId: string }>(
  getCollection: (state: PerpsState) => Readonly<Record<string, T>>,
  accountId: string,
) {
  let source: Readonly<Record<string, T>> | null = null;
  let result: readonly T[] = [];
  return (state: PerpsState): readonly T[] => {
    const next = getCollection(state);
    if (next !== source) {
      source = next;
      result = Object.values(next).filter((value) => value.accountId === accountId);
    }
    return result;
  };
}
export const selectAccountStops = (accountId: string) => accountValues((state) => state.stops, accountId);
export const selectAccountTwaps = (accountId: string) => accountValues((state) => state.twaps, accountId);
export const selectAccountFills = (accountId: string) => accountValues((state) => state.fills, accountId);
export const selectAccountHistory = (accountId: string) => accountValues((state) => state.history, accountId);
export const selectAccountFundingPayments = (accountId: string) => accountValues((state) => state.fundingPayments, accountId);
export const selectCandles = (marketId: string, interval?: string) => {
  let source: PerpsState["candles"] | null = null;
  let result: readonly Candle[] = [];
  return (state: PerpsState) => {
    if (state.candles !== source) {
      source = state.candles;
      result = Object.values(state.candles).filter((value) => value.marketId === marketId && (interval === undefined || value.interval === interval));
    }
    return result;
  };
};

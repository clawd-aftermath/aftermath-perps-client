import {
  Decimal,
  decimal,
  decimalString,
  nonNegativeDecimal,
  positiveDecimal,
} from "./decimal.js";
import { emptyPerpsData } from "./store.js";
import type {
  Account,
  AccountHistoryItem,
  Candle,
  CollateralBalance,
  DeltaStream,
  Fill,
  Funding,
  FundingPayment,
  Market,
  MarketPrice,
  Order,
  Orderbook,
  OrderbookLevel,
  PerpsDelta,
  PerpsSnapshot,
  Position,
  Side,
  SnapshotSource,
  StopOrder,
  StreamConnection,
  StreamHandlers,
  TwapOrder,
  Vault,
} from "./types.js";

export const AFTERMATH_MAINNET_URL = "https://aftermath.finance";
export const AFTERMATH_UPDATES_PATH = "/api/perpetuals/ws/updates";
export const DEFAULT_AFTERMATH_TIMEOUT_MS = 10_000;

type UnknownRecord = Record<string, unknown>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value.endsWith("n") && /^-?\d+n$/.test(value)
      ? value.slice(0, -1)
      : value;
  }
  if (
    typeof value === "bigint" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return String(value);
  }
  return null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bigintValue(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+n?$/.test(value)) {
    return BigInt(value.endsWith("n") ? value.slice(0, -1) : value);
  }
  return null;
}

function safeIntegerValue(value: unknown): number | null {
  const normalized = bigintValue(value);
  if (normalized !== null) {
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return numberValue(value);
}

function idFrom(value: unknown, ...keys: readonly string[]): string | null {
  const item = record(value);
  if (item === null) {
    return null;
  }
  for (const key of keys) {
    const id = stringValue(item[key]);
    if (id !== null) {
      return id;
    }
  }
  return null;
}

function sideValue(value: unknown): Side | null {
  if (value === "buy" || value === "bid" || value === 0 || value === "0") {
    return "buy";
  }
  if (value === "sell" || value === "ask" || value === 1 || value === "1") {
    return "sell";
  }
  return null;
}

function bigintWireReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value}n` : value;
}

function bigintWireReviver(_key: string, value: unknown): unknown {
  return typeof value === "string" && /^-?\d+n$/.test(value)
    ? BigInt(value.slice(0, -1))
    : value;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text, bigintWireReviver) as unknown;
  } catch (error) {
    if (!response.ok) {
      return text;
    }
    throw new Error("Aftermath response was not valid JSON", { cause: error });
  }
}

export class AftermathHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly errorCode: string | null;

  constructor(response: Response, body: unknown) {
    const bodyRecord = record(body);
    const bodyMessage =
      bodyRecord === null
        ? typeof body === "string"
          ? body
          : null
        : stringValue(bodyRecord.error) ?? stringValue(bodyRecord.message);
    super(
      bodyMessage ??
        response.headers.get("X-Error-Message") ??
        `HTTP ${response.status}`,
    );
    this.name = "AftermathHttpError";
    this.status = response.status;
    this.body = body;
    this.errorCode = response.headers.get("X-Error-Code");
  }
}

export async function aftermathPost(
  baseUrl: string,
  path: string,
  body: unknown,
  fetcher: FetchLike,
  signal: AbortSignal,
  timeoutMs = DEFAULT_AFTERMATH_TIMEOUT_MS,
): Promise<unknown> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }
  const requestSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(timeoutMs),
  ]);
  const response = await fetcher(new URL(path, baseUrl), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body, bigintWireReplacer),
    signal: requestSignal,
  });
  const data = await readJson(response);
  if (!response.ok) {
    throw new AftermathHttpError(response, data);
  }
  return data;
}

function level(value: unknown): OrderbookLevel | null {
  if (Array.isArray(value)) {
    const price = stringValue(value[0]);
    const size = stringValue(value[1]);
    return price !== null && size !== null ? { price, size } : null;
  }
  const item = record(value);
  if (item === null) {
    return null;
  }
  const price = stringValue(item.price);
  const size = stringValue(item.size ?? item.currentSize ?? item.quantity);
  return price !== null && size !== null ? { price, size } : null;
}

function levels(value: unknown): readonly OrderbookLevel[] {
  return array(value)
    .map(level)
    .filter((item): item is OrderbookLevel => item !== null);
}

function canonicalLevels(
  value: unknown,
  descending: boolean,
): readonly OrderbookLevel[] {
  return levels(value)
    .map((item) => ({
      price: decimalString(positiveDecimal(item.price, "orderbook price")),
      size: decimalString(nonNegativeDecimal(item.size, "orderbook size")),
    }))
    .filter((item) => !decimal(item.size).isZero())
    .sort((left, right) => {
      const comparison = decimal(left.price).comparedTo(decimal(right.price));
      return descending ? -comparison : comparison;
    });
}

function normalizeMarket(value: unknown, metadataValue?: unknown): Market | null {
  const item = record(value);
  const metadata = record(metadataValue);
  if (item === null) {
    return null;
  }
  const id = idFrom(item, "objectId", "marketId", "id");
  if (id === null) {
    return null;
  }
  const params = record(item.marketParams);
  return {
    id,
    symbol:
      stringValue(metadata?.symbol) ??
      stringValue(params?.baseAssetSymbol) ??
      stringValue(item.symbol) ??
      id,
    displayName: stringValue(metadata?.displayName),
    collateralCoinType: stringValue(item.collateralCoinType),
    lotSize: stringValue(params?.lotSize),
    tickSize: stringValue(params?.tickSize),
    initialMarginRatio: stringValue(params?.marginRatioInitial),
    maintenanceMarginRatio: stringValue(params?.marginRatioMaintenance),
    raw: value,
  };
}

function marketPatch(
  value: unknown,
): { id: string; value: Partial<Omit<Market, "id">> } | null {
  const item = record(value);
  if (item === null) {
    return null;
  }
  const id = idFrom(item, "objectId", "marketId", "id");
  if (id === null) {
    return null;
  }
  const params = record(item.marketParams);
  const patch: Mutable<Partial<Omit<Market, "id">>> = { raw: value };
  const collateralCoinType = stringValue(item.collateralCoinType);
  const lotSize = stringValue(params?.lotSize);
  const tickSize = stringValue(params?.tickSize);
  const initialMarginRatio = stringValue(params?.marginRatioInitial);
  const maintenanceMarginRatio = stringValue(params?.marginRatioMaintenance);
  if (collateralCoinType !== null) patch.collateralCoinType = collateralCoinType;
  if (lotSize !== null) patch.lotSize = lotSize;
  if (tickSize !== null) patch.tickSize = tickSize;
  if (initialMarginRatio !== null) patch.initialMarginRatio = initialMarginRatio;
  if (maintenanceMarginRatio !== null) {
    patch.maintenanceMarginRatio = maintenanceMarginRatio;
  }
  return { id, value: patch };
}

function normalizePrice(value: unknown): MarketPrice | null {
  const item = record(value);
  if (item === null) {
    return null;
  }
  const marketId = idFrom(item, "marketId", "id");
  if (marketId === null) {
    return null;
  }
  return {
    id: marketId,
    marketId,
    indexPrice: stringValue(item.basePrice ?? item.indexPrice),
    markPrice: stringValue(item.markPrice),
    bookPrice: stringValue(item.bookPrice),
    midPrice: stringValue(item.midPrice),
    collateralPrice: stringValue(item.collateralPrice),
    updatedAt: numberValue(item.updatedAt ?? item.timestampMs),
    raw: value,
  };
}

function pricePatch(
  value: unknown,
): { id: string; value: Partial<Omit<MarketPrice, "id">> } | null {
  const item = record(value);
  if (item === null) {
    return null;
  }
  const marketId = idFrom(item, "marketId", "id");
  if (marketId === null) {
    return null;
  }
  const patch: Mutable<Partial<Omit<MarketPrice, "id">>> = {
    marketId,
    raw: value,
  };
  const indexPrice = stringValue(item.basePrice ?? item.indexPrice);
  const markPrice = stringValue(item.markPrice);
  const collateralPrice = stringValue(item.collateralPrice);
  const midPrice = stringValue(item.midPrice);
  if (indexPrice !== null) patch.indexPrice = indexPrice;
  if (markPrice !== null) patch.markPrice = markPrice;
  if (collateralPrice !== null) patch.collateralPrice = collateralPrice;
  if (midPrice !== null) patch.midPrice = midPrice;
  if ("bookPrice" in item) {
    patch.bookPrice = stringValue(item.bookPrice);
  }
  const updatedAt = numberValue(item.updatedAt ?? item.timestampMs);
  if (updatedAt !== null) patch.updatedAt = updatedAt;
  return { id: marketId, value: patch };
}

function normalizeOrderbook(value: unknown, marketId: string): Orderbook | null {
  const outer = record(value);
  if (outer === null) {
    return null;
  }
  const book = record(outer.orderbook) ?? outer;
  const nonce = bigintValue(book.nonce ?? outer.nonce);
  if (nonce === null) {
    return null;
  }
  return {
    id: marketId,
    marketId,
    bids: canonicalLevels(book.bids, true),
    asks: canonicalLevels(book.asks, false),
    nonce,
    updatedAt: numberValue(outer.updatedAt ?? outer.timestampMs),
    raw: value,
  };
}

function normalizePosition(value: unknown, accountId: string): Position | null {
  const item = record(value);
  if (item === null) {
    return null;
  }
  const marketId = idFrom(item, "marketId", "clearingHouseId");
  const signedValue = stringValue(item.baseAssetAmount);
  if (marketId === null || signedValue === null) {
    return null;
  }
  const signedSize = decimal(signedValue, "position.baseAssetAmount");
  return {
    id: `${accountId}:${marketId}`,
    accountId,
    marketId,
    side: signedSize.gt(0) ? "buy" : signedSize.lt(0) ? "sell" : null,
    size: decimalString(signedSize.abs()),
    collateral: stringValue(item.collateral),
    leverage: stringValue(item.leverage),
    entryPrice: stringValue(item.entryPrice),
    marginRatio: stringValue(item.marginRatio),
    raw: value,
  };
}

function normalizeOrder(
  value: unknown,
  accountId: string | null,
  fallbackMarketId?: string,
): Order | null {
  const item = record(value);
  if (item === null) {
    return null;
  }
  const id = idFrom(item, "orderId", "id");
  const marketId =
    idFrom(item, "marketId", "clearingHouseId") ?? fallbackMarketId ?? null;
  const side = sideValue(item.side);
  const initialValue = stringValue(item.initialSize);
  const currentValue = stringValue(item.currentSize);
  if (
    id === null ||
    marketId === null ||
    side === null ||
    initialValue === null ||
    currentValue === null
  ) {
    return null;
  }
  const initial = nonNegativeDecimal(initialValue, "order.initialSize");
  const current = nonNegativeDecimal(currentValue, "order.currentSize");
  const filled = Decimal.max(0, initial.sub(current));
  return {
    id,
    accountId,
    marketId,
    side,
    size: decimalString(initial),
    filledSize: decimalString(filled),
    price: null,
    status: filled.eq(initial) && initial.gt(0)
      ? "filled"
      : filled.gt(0)
        ? "partially-filled"
        : "open",
    clientOrderId: stringValue(item.clientOrderId),
    raw: value,
  };
}

function normalizeAccount(value: unknown): {
  readonly account: Account;
  readonly positions: readonly Position[];
  readonly orders: readonly Order[];
  readonly collateral: CollateralBalance | null;
} | null {
  const wrapper = record(value);
  if (wrapper === null) {
    return null;
  }
  const item = record(wrapper.account) ?? wrapper;
  const cap = record(wrapper.accountCap);
  const id = idFrom(item, "accountId", "id", "accountNumber");
  if (id === null) {
    return null;
  }
  const positions = array(item.positions)
    .map((position) => normalizePosition(position, id))
    .filter((position): position is Position => position !== null);
  const orders = positions.flatMap((position) => {
    const rawPosition = record(position.raw);
    return array(rawPosition?.pendingOrders)
      .map((order) => normalizeOrder(order, id, position.marketId))
      .filter((order): order is Order => order !== null);
  });
  const availableCollateral = stringValue(item.availableCollateral);
  const availableCollateralUsd = stringValue(item.availableCollateralUsd);
  const totalEquityUsd = stringValue(item.totalEquityUsd);
  const coinType = stringValue(
    wrapper.collateralCoinType ?? cap?.collateralCoinType,
  );
  return {
    account: {
      id,
      ownerAddress: stringValue(cap?.walletAddress ?? wrapper.ownerAddress),
      collateralCoinType: coinType,
      availableCollateral,
      availableCollateralUsd,
      totalEquityUsd,
      raw: value,
    },
    positions,
    orders,
    collateral:
      availableCollateral === null ||
      availableCollateralUsd === null ||
      totalEquityUsd === null
        ? null
        : {
            id,
            accountId: id,
            coinType,
            available: availableCollateral,
            availableUsd: availableCollateralUsd,
            totalEquityUsd,
            raw: value,
          },
  };
}

function normalizeStop(value: unknown, accountId: string): StopOrder | null {
  const item = record(value);
  if (item === null) return null;
  const id = idFrom(item, "objectId", "id");
  const marketId = idFrom(item, "marketId");
  const side = sideValue(item.side);
  const size = stringValue(item.size);
  if (id === null || marketId === null || side === null || size === null) return null;
  const slTp = record(item.slTp);
  const nonSlTp = record(item.nonSlTp);
  const stopLossPrice = stringValue(slTp?.stopLossPrice);
  const takeProfitPrice = stringValue(slTp?.takeProfitPrice);
  return {
    id,
    accountId,
    marketId,
    side,
    triggerPrice: stopLossPrice ?? takeProfitPrice ?? stringValue(nonSlTp?.stopIndexPrice),
    orderPrice: stringValue(record(item.limitOrder)?.price),
    size,
    kind: stopLossPrice !== null && takeProfitPrice !== null ? "stop-loss-take-profit" : stopLossPrice !== null ? "stop-loss" : takeProfitPrice !== null ? "take-profit" : "stop",
    status: stringValue(item.orderState) ?? "unknown",
    stopLossPrice,
    takeProfitPrice,
    expiresAt: safeIntegerValue(item.expiryTimestamp),
    raw: value,
  };
}

function normalizeTwap(value: unknown, accountId: string): TwapOrder | null {
  const item = record(value);
  const details = record(item?.details);
  if (item === null || details === null) return null;
  const id = idFrom(item, "twapOrderObjectId", "objectId", "id");
  const marketId = idFrom(details, "marketId");
  const side = sideValue(details.side);
  const totalSize = stringValue(details.size);
  const processed = stringValue(item.processedAmount);
  if (id === null || marketId === null || side === null || totalSize === null || processed === null) return null;
  const remaining = Decimal.max(0, decimal(totalSize).sub(decimal(processed)));
  return {
    id,
    accountId,
    marketId,
    side,
    totalSize,
    remainingSize: decimalString(remaining),
    firstRunExpiresAt: safeIntegerValue(details.firstRunExpireTimestamp),
    expiresAt: safeIntegerValue(details.expireTimestamp),
    lastExecutionAt: safeIntegerValue(item.lastExecutionTimestampMs),
    status: stringValue(item.orderState) ?? "unknown",
    raw: value,
  };
}

function normalizeOrderHistory(value: unknown, accountId: string, ordinal = 0): AccountHistoryItem | null {
  const item = record(value);
  if (item === null) return null;
  const timestamp = safeIntegerValue(item.timestamp);
  const digest = stringValue(item.txDigest);
  const marketId = idFrom(item, "marketId");
  const eventType = stringValue(item.eventType);
  if (timestamp === null || digest === null || marketId === null || eventType === null) return null;
  return {
    id: `${accountId}:${digest}:${eventType}:${marketId}:${timestamp}:${ordinal}`,
    accountId,
    type: eventType,
    timestamp,
    cursor: null,
    raw: value,
  };
}

function normalizeFill(value: unknown, accountId: string, ordinal = 0): Fill | null {
  const item = record(value);
  const eventType = stringValue(item?.eventType);
  if (item === null || eventType === null || !/(^|::)Filled(Taker|Maker)Order$/.test(eventType)) return null;
  const history = normalizeOrderHistory(value, accountId, ordinal);
  const side = sideValue(item.side);
  const price = stringValue(item.price);
  const size = stringValue(item.size);
  const marketId = idFrom(item, "marketId");
  if (history === null || side === null || price === null || size === null || marketId === null) return null;
  return { id: history.id, accountId, marketId, orderId: stringValue(item.orderId), side, price, size, timestamp: history.timestamp, pnl: stringValue(item.pnl), fees: stringValue(item.fees), raw: value };
}

function normalizeFunding(value: unknown, marketId: string): Funding {
  const item = record(value);
  const marketState = record(item?.marketState);
  return {
    id: marketId,
    marketId,
    estimatedRate: stringValue(item?.estimatedFundingRate),
    cumulativeRateLong: stringValue(marketState?.cumFundingRateLong),
    cumulativeRateShort: stringValue(marketState?.cumFundingRateShort),
    nextFundingAt: safeIntegerValue(item?.nextFundingTimestampMs),
    updatedAt: safeIntegerValue(marketState?.fundingLastUpdateTimestamp),
    raw: value,
  };
}

function fundingPatch(
  value: unknown,
  marketId: string,
): Partial<Omit<Funding, "id">> {
  const item = record(value);
  const marketState = record(item?.marketState);
  const patch: Mutable<Partial<Omit<Funding, "id">>> = {
    marketId,
    raw: value,
  };
  const estimatedRate = stringValue(item?.estimatedFundingRate);
  const cumulativeRateLong = stringValue(marketState?.cumFundingRateLong);
  const cumulativeRateShort = stringValue(marketState?.cumFundingRateShort);
  const nextFundingAt = safeIntegerValue(item?.nextFundingTimestampMs);
  const updatedAt = safeIntegerValue(marketState?.fundingLastUpdateTimestamp);
  if (estimatedRate !== null) patch.estimatedRate = estimatedRate;
  if (cumulativeRateLong !== null) {
    patch.cumulativeRateLong = cumulativeRateLong;
  }
  if (cumulativeRateShort !== null) {
    patch.cumulativeRateShort = cumulativeRateShort;
  }
  if (nextFundingAt !== null) patch.nextFundingAt = nextFundingAt;
  if (updatedAt !== null) patch.updatedAt = updatedAt;
  return patch;
}

function normalizeVault(value: unknown): Vault | null {
  const item = record(value);
  if (item === null) {
    return null;
  }
  const id = idFrom(item, "objectId", "vaultId", "id");
  if (id === null) {
    return null;
  }
  const metadata = record(item.metadata);
  return {
    id,
    name: stringValue(metadata?.name),
    accountId: stringValue(item.accountId),
    collateralCoinType: stringValue(item.collateralCoinType),
    lpCoinType: stringValue(item.lpCoinType),
    tvlUsd: stringValue(item.tvlUsd),
    pausedUntilTimestamp: stringValue(item.pausedUntilTimestamp),
    raw: value,
  };
}

function put<T extends { id: string }>(
  target: Record<string, T>,
  value: T | null,
): void {
  if (value !== null) {
    target[value.id] = value;
  }
}

function validatedAccountIds(
  values: readonly (string | bigint)[],
): readonly bigint[] {
  return values.map((value, index) => {
    if (typeof value === "bigint") {
      if (value < 0n) {
        throw new RangeError(`accountIds[${index}] must be non-negative`);
      }
      return value;
    }
    if (!/^(?:0|[1-9]\d*)$/.test(value)) {
      throw new TypeError(
        `accountIds[${index}] must be an unsigned base-10 integer string`,
      );
    }
    return BigInt(value);
  });
}

export interface AftermathNativeSnapshotOptions {
  readonly collateralCoinType: string;
  readonly accountIds?: readonly (string | bigint)[];
  readonly vaultIds?: readonly string[];
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly includeVaults?: boolean;
  readonly timeoutMs?: number;
}

export function createAftermathNativeSnapshotSource(
  options: AftermathNativeSnapshotOptions,
): SnapshotSource {
  const baseUrl = options.baseUrl ?? AFTERMATH_MAINNET_URL;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const accountIds = validatedAccountIds(options.accountIds ?? []);
  const timeoutMs = options.timeoutMs ?? DEFAULT_AFTERMATH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }

  const post = (
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> =>
    aftermathPost(baseUrl, path, body, fetcher, signal, timeoutMs);

  return {
    fetchSnapshot: async (signal): Promise<PerpsSnapshot> => {
      const allMarketsResponse = await post(
        "/api/perpetuals/all-markets",
        { collateralCoinType: options.collateralCoinType },
        signal,
      );
      const allMarkets = array(record(allMarketsResponse)?.markets);
      const marketIds = allMarkets
        .map((market) => idFrom(market, "objectId", "marketId", "id"))
        .filter((id): id is string => id !== null);

      const requests: [
        Promise<unknown>,
        Promise<unknown>,
        Promise<unknown>,
        Promise<unknown>,
        Promise<unknown>,
      ] = [
        marketIds.length === 0
          ? Promise.resolve({ marketDatas: [] })
          : post("/api/perpetuals/markets", { marketIds }, signal),
        marketIds.length === 0
          ? Promise.resolve({ marketsPrices: [] })
          : post("/api/perpetuals/markets/prices", { marketIds }, signal),
        marketIds.length === 0
          ? Promise.resolve({ orderbooks: [] })
          : post("/api/perpetuals/markets/orderbooks", { marketIds }, signal),
        accountIds.length === 0
          ? Promise.resolve({ accounts: [] })
          : post("/api/perpetuals/accounts/positions", { accountIds }, signal),
        options.includeVaults === false
          ? Promise.resolve({ vaults: [] })
          : post(
              "/api/perpetuals/vaults",
              options.vaultIds === undefined ? {} : { vaultIds: options.vaultIds },
              signal,
            ),
      ];

      const [
        marketsResponse,
        pricesResponse,
        booksResponse,
        accountsResponse,
        vaultsResponse,
      ] = await Promise.all(requests);
      const data = emptyPerpsData();
      const markets: Record<string, Market> = {};
      const prices: Record<string, MarketPrice> = {};
      const orderbooks: Record<string, Orderbook> = {};
      const accounts: Record<string, Account> = {};
      const positions: Record<string, Position> = {};
      const orders: Record<string, Order> = {};
      const collateral: Record<string, CollateralBalance> = {};
      const funding: Record<string, Funding> = {};
      const vaults: Record<string, Vault> = {};

      for (const value of allMarkets) {
        put(markets, normalizeMarket(value));
      }
      for (const value of array(record(marketsResponse)?.marketDatas)) {
        const marketData = record(value);
        const market = normalizeMarket(marketData?.market, marketData?.metadata);
        put(markets, market);
        if (market !== null) {
          put(funding, normalizeFunding(marketData?.market, market.id));
        }
      }
      for (const value of array(record(pricesResponse)?.marketsPrices)) {
        put(prices, normalizePrice(value));
      }
      const bookWrappers = array(record(booksResponse)?.orderbooks);
      if (bookWrappers.length !== marketIds.length) {
        throw new Error(
          `Aftermath returned ${bookWrappers.length} orderbooks for ${marketIds.length} requested markets`,
        );
      }
      for (const [index, marketId] of marketIds.entries()) {
        const orderbook = normalizeOrderbook(bookWrappers[index], marketId);
        if (orderbook === null) {
          throw new Error(
            `Aftermath returned an invalid orderbook at response index ${index}`,
          );
        }
        put(orderbooks, orderbook);
      }
      for (const value of array(record(accountsResponse)?.accounts)) {
        const normalized = normalizeAccount(value);
        if (normalized === null) {
          continue;
        }
        put(accounts, normalized.account);
        for (const position of normalized.positions) put(positions, position);
        for (const order of normalized.orders) put(orders, order);
        put(collateral, normalized.collateral);
      }
      for (const value of array(record(vaultsResponse)?.vaults)) {
        put(vaults, normalizeVault(value));
      }

      return {
        data: {
          ...data,
          markets,
          prices,
          orderbooks,
          accounts,
          positions,
          orders,
          collateral,
          funding,
          vaults,
        },
        receivedAt: Date.now(),
      };
    },
  };
}

export type AftermathSubscription =
  | { readonly market: { readonly marketId: string } }
  | { readonly oracle: { readonly marketId: string } }
  | { readonly orderbook: { readonly marketId: string } }
  | {
      readonly user: {
        readonly accountId: bigint;
        readonly withStopOrders: {
          readonly walletAddress: string;
          readonly bytes: string;
          readonly signature: string;
        } | undefined;
      };
    }
  | { readonly userOrders: { readonly accountId: bigint } }
  | { readonly userCollateralChanges: { readonly accountId: bigint } }
  | { readonly marketCandles: { readonly marketId: string; readonly interval: string } };

export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface AftermathWebSocketOptions {
  readonly subscriptions: readonly AftermathSubscription[];
  readonly baseUrl?: string;
  readonly createWebSocket?: (url: string) => WebSocketLike;
  readonly decodeMessage?: (message: unknown) => readonly PerpsDelta[];
  readonly onUnhandledMessage?: (message: unknown) => void;
}

export function decodeAftermathMessage(message: unknown): readonly PerpsDelta[] {
  const envelope = record(message);
  if (envelope === null) {
    return [];
  }

  const userPayload = record(envelope.user);
  if (userPayload !== null) {
    const normalized = normalizeAccount(userPayload.account);
    if (normalized !== null) {
      const stops = array(userPayload.stopOrders)
        .map((value) => normalizeStop(value, normalized.account.id))
        .filter((value): value is StopOrder => value !== null);
      const twaps = array(userPayload.twapOrders)
        .map((value) => normalizeTwap(value, normalized.account.id))
        .filter((value): value is TwapOrder => value !== null);
      return [
        { kind: "upsert", collection: "accounts", value: normalized.account },
        { kind: "replaceScope", collection: "positions", accountId: normalized.account.id, values: normalized.positions },
        { kind: "replaceScope", collection: "orders", accountId: normalized.account.id, values: normalized.orders },
        ...(normalized.collateral === null ? [] : [{ kind: "upsert" as const, collection: "collateral" as const, value: normalized.collateral }]),
        { kind: "replaceScope", collection: "stops", accountId: normalized.account.id, values: stops },
        { kind: "replaceScope", collection: "twaps", accountId: normalized.account.id, values: twaps },
      ];
    }
  }

  const userOrdersPayload = record(envelope.userOrders);
  if (userOrdersPayload !== null) {
    const accountId = stringValue(userOrdersPayload.accountId);
    if (accountId !== null && /^\d+$/.test(accountId)) {
      return array(userOrdersPayload.orders).flatMap((value, ordinal) => {
        const history = normalizeOrderHistory(value, accountId, ordinal);
        const fill = normalizeFill(value, accountId, ordinal);
        return [
          ...(history === null ? [] : [{ kind: "upsert" as const, collection: "history" as const, value: history }]),
          ...(fill === null ? [] : [{ kind: "upsert" as const, collection: "fills" as const, value: fill }]),
        ];
      });
    }
  }

  const collateralPayload = record(envelope.userCollateralChanges);
  if (collateralPayload !== null) {
    const accountId = stringValue(collateralPayload.accountId);
    if (accountId !== null && /^\d+$/.test(accountId)) {
      return array(collateralPayload.collateralChanges).flatMap((value, ordinal) => {
        const item = record(value);
        const timestamp = safeIntegerValue(item?.timestamp);
        const digest = stringValue(item?.txDigest);
        const eventType = stringValue(item?.eventType);
        if (timestamp === null || digest === null || eventType === null) return [];
        const history: AccountHistoryItem = {
          id: `${accountId}:${digest}:${eventType}:${timestamp}:${ordinal}`,
          accountId,
          type: eventType,
          timestamp,
          cursor: null,
          raw: value,
        };
        const marketId = idFrom(item, "marketId");
        const fundingPayment: FundingPayment | null = /(^|::)SettledFunding$/.test(eventType) && marketId !== null
          ? { id: history.id, accountId, marketId, amount: stringValue(item?.collateralChange) ?? "0", timestamp, raw: value }
          : null;
        return [
          { kind: "upsert" as const, collection: "history" as const, value: history },
          ...(fundingPayment === null ? [] : [{ kind: "upsert" as const, collection: "fundingPayments" as const, value: fundingPayment }]),
        ];
      });
    }
  }

  const candlesPayload = record(envelope.marketCandles);
  if (candlesPayload !== null) {
    const marketId = idFrom(candlesPayload, "marketId");
    const interval = stringValue(candlesPayload.interval);
    const point = record(candlesPayload.lastCandle);
    const startedAt = safeIntegerValue(point?.timestamp);
    const open = stringValue(point?.open);
    const high = stringValue(point?.high);
    const low = stringValue(point?.low);
    const close = stringValue(point?.close);
    if (marketId !== null && interval !== null && startedAt !== null && open !== null && high !== null && low !== null && close !== null) {
      const candle: Candle = { id: `${marketId}:${interval}:${startedAt}`, marketId, interval, startedAt, open, high, low, close, volume: stringValue(point?.volume), raw: candlesPayload.lastCandle };
      return [{ kind: "upsert", collection: "candles", value: candle }];
    }
  }

  const orderbookPayload = record(envelope.orderbook);
  if (orderbookPayload !== null) {
    const marketId = idFrom(orderbookPayload, "marketId", "id");
    const deltas = record(orderbookPayload.orderbookDeltas);
    const nonce = bigintValue(deltas?.nonce);
    if (marketId !== null && deltas !== null && nonce !== null) {
      return [
        {
          kind: "orderbook",
          marketId,
          bids: levels(deltas.bidsDeltas),
          asks: levels(deltas.asksDeltas),
          replace: false,
          nonce,
          raw: message,
        },
      ];
    }
  }

  const oraclePayload = record(envelope.oracle);
  if (oraclePayload !== null) {
    const patch = pricePatch(oraclePayload);
    if (patch !== null) {
      return [
        {
          kind: "patch",
          collection: "prices",
          id: patch.id,
          value: patch.value,
        },
      ];
    }
  }

  const marketPayload = record(envelope.market);
  if (marketPayload !== null) {
    const patch = marketPatch(marketPayload);
    if (patch !== null) {
      return [
        {
          kind: "patch",
          collection: "markets",
          id: patch.id,
          value: patch.value,
        },
        {
          kind: "patch",
          collection: "funding",
          id: patch.id,
          value: fundingPatch(marketPayload, patch.id),
        },
      ];
    }
  }

  return [];
}

export function createAftermathWebSocketStream(
  options: AftermathWebSocketOptions,
): DeltaStream {
  const baseUrl = options.baseUrl ?? AFTERMATH_MAINNET_URL;
  const websocketUrl = new URL(AFTERMATH_UPDATES_PATH, baseUrl);
  websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
  const decode = options.decodeMessage ?? decodeAftermathMessage;

  const createSocket =
    options.createWebSocket ??
    ((url: string): WebSocketLike => {
      if (typeof globalThis.WebSocket !== "function") {
        throw new Error(
          "No WebSocket implementation found; provide createWebSocket",
        );
      }
      return new globalThis.WebSocket(url) as unknown as WebSocketLike;
    });

  return {
    connect(handlers: StreamHandlers): StreamConnection {
      const socket = createSocket(websocketUrl.toString());
      socket.onopen = () => {
        for (const subscriptionType of options.subscriptions) {
          const accountId = "user" in subscriptionType
            ? subscriptionType.user.accountId
            : "userOrders" in subscriptionType
              ? subscriptionType.userOrders.accountId
              : "userCollateralChanges" in subscriptionType
                ? subscriptionType.userCollateralChanges.accountId
                : null;
          if (accountId !== null && accountId < 0n) {
            handlers.onError(new RangeError("subscription accountId must be non-negative"));
            continue;
          }
          socket.send(
            JSON.stringify(
              { action: "subscribe", subscriptionType },
              bigintWireReplacer,
            ),
          );
        }
        handlers.onOpen();
      };
      socket.onmessage = (event) => {
        try {
          const text =
            typeof event.data === "string"
              ? event.data
              : event.data instanceof ArrayBuffer
                ? new TextDecoder().decode(event.data)
                : null;
          if (text === null) {
            throw new TypeError("Unsupported WebSocket message type");
          }
          const message = JSON.parse(text, bigintWireReviver) as unknown;
          const deltas = decode(message);
          if (deltas.length === 0) {
            options.onUnhandledMessage?.(message);
          }
          for (const delta of deltas) {
            handlers.onDelta(delta);
          }
        } catch (error) {
          handlers.onError(error);
        }
      };
      socket.onclose = (event) => handlers.onClose(event);
      socket.onerror = (event) => handlers.onError(event);
      return {
        close: () => socket.close(),
      };
    },
  };
}

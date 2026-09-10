export type DecimalValue = string | number | bigint;
export type EntityId = string;
export type EntityMap<T extends { id: EntityId }> = Readonly<Record<EntityId, T>>;
export type Side = "buy" | "sell";
export type OrderStatus = "open" | "partially-filled" | "filled" | "cancelled" | "rejected";

export interface Market {
  readonly id: string;
  readonly symbol: string;
  readonly displayName: string | null;
  readonly collateralCoinType: string | null;
  readonly lotSize: string | null;
  readonly tickSize: string | null;
  readonly initialMarginRatio: string | null;
  readonly maintenanceMarginRatio: string | null;
  readonly raw: unknown;
}

export interface MarketPrice {
  readonly id: string;
  readonly marketId: string;
  readonly indexPrice: string | null;
  readonly markPrice: string | null;
  readonly bookPrice: string | null;
  readonly midPrice: string | null;
  readonly collateralPrice: string | null;
  readonly updatedAt: number | null;
  readonly raw: unknown;
}

export interface OrderbookLevel {
  readonly price: string;
  readonly size: string;
}

export interface Orderbook {
  readonly id: string;
  readonly marketId: string;
  readonly bids: readonly OrderbookLevel[];
  readonly asks: readonly OrderbookLevel[];
  readonly nonce: bigint | null;
  readonly updatedAt: number | null;
  readonly raw: unknown;
}

export interface Account {
  readonly id: string;
  readonly ownerAddress: string | null;
  readonly collateralCoinType: string | null;
  readonly availableCollateral: string | null;
  readonly availableCollateralUsd: string | null;
  readonly totalEquityUsd: string | null;
  readonly raw: unknown;
}

export interface Position {
  readonly id: string;
  readonly accountId: string;
  readonly marketId: string;
  readonly side: Side | null;
  readonly size: string;
  readonly collateral: string | null;
  readonly leverage: string | null;
  readonly entryPrice: string | null;
  readonly marginRatio: string | null;
  readonly raw: unknown;
}

export interface Order {
  readonly id: string;
  readonly accountId: string | null;
  readonly marketId: string;
  readonly side: Side;
  readonly size: string;
  readonly filledSize: string;
  readonly price: string | null;
  readonly status: OrderStatus;
  readonly clientOrderId: string | null;
  readonly raw: unknown;
}

export interface CollateralBalance {
  readonly id: string;
  readonly accountId: string;
  readonly coinType: string | null;
  readonly available: string;
  readonly availableUsd: string;
  readonly totalEquityUsd: string;
  readonly raw: unknown;
}

export interface Funding {
  readonly id: string;
  readonly marketId: string;
  readonly estimatedRate: string | null;
  readonly cumulativeRateLong: string | null;
  readonly cumulativeRateShort: string | null;
  readonly nextFundingAt: number | null;
  readonly updatedAt: number | null;
  readonly raw: unknown;
}

export interface StopOrder {
  readonly id: string; readonly accountId: string; readonly marketId: string;
  readonly side: Side; readonly triggerPrice: string | null; readonly orderPrice: string | null;
  readonly size: string; readonly kind: "stop" | "take-profit" | "stop-loss" | "stop-loss-take-profit";
  readonly status: string; readonly stopLossPrice: string | null; readonly takeProfitPrice: string | null;
  readonly expiresAt: number | null; readonly raw: unknown;
}
export interface TwapOrder {
  readonly id: string; readonly accountId: string; readonly marketId: string;
  readonly side: Side; readonly totalSize: string; readonly remainingSize: string;
  readonly firstRunExpiresAt: number | null; readonly expiresAt: number | null;
  readonly lastExecutionAt: number | null; readonly status: string; readonly raw: unknown;
}
export interface Fill {
  readonly id: string; readonly accountId: string; readonly marketId: string;
  readonly orderId: string | null; readonly side: Side; readonly price: string;
  readonly size: string; readonly timestamp: number | null; readonly raw: unknown;
  readonly pnl: string | null; readonly fees: string | null;
}
export interface AccountHistoryItem {
  readonly id: string; readonly accountId: string; readonly type: string;
  readonly timestamp: number | null; readonly cursor: string | null; readonly raw: unknown;
}
export interface FundingPayment {
  readonly id: string; readonly accountId: string; readonly marketId: string;
  readonly amount: string; readonly timestamp: number | null; readonly raw: unknown;
}
export interface Candle {
  readonly id: string; readonly marketId: string; readonly interval: string;
  readonly startedAt: number; readonly open: string; readonly high: string;
  readonly low: string; readonly close: string; readonly volume: string | null; readonly raw: unknown;
}

export interface Vault {
  readonly id: string;
  readonly name: string | null;
  readonly accountId: string | null;
  readonly collateralCoinType: string | null;
  readonly lpCoinType: string | null;
  readonly tvlUsd: string | null;
  readonly pausedUntilTimestamp: string | null;
  readonly raw: unknown;
}

export interface PerpsData {
  readonly markets: EntityMap<Market>;
  readonly prices: EntityMap<MarketPrice>;
  readonly orderbooks: EntityMap<Orderbook>;
  readonly accounts: EntityMap<Account>;
  readonly positions: EntityMap<Position>;
  readonly orders: EntityMap<Order>;
  readonly collateral: EntityMap<CollateralBalance>;
  readonly funding: EntityMap<Funding>;
  readonly stops: EntityMap<StopOrder>;
  readonly twaps: EntityMap<TwapOrder>;
  readonly fills: EntityMap<Fill>;
  readonly history: EntityMap<AccountHistoryItem>;
  readonly fundingPayments: EntityMap<FundingPayment>;
  readonly candles: EntityMap<Candle>;
  readonly vaults: EntityMap<Vault>;
}

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "resyncing"
  | "live"
  | "reconnecting"
  | "stopped"
  | "error";

export interface PerpsState extends PerpsData {
  readonly connection: {
    readonly status: ConnectionStatus;
    readonly stale: boolean;
    readonly generation: number;
    readonly reconnectCount: number;
    readonly snapshotAt: number | null;
    readonly error: Error | null;
  };
}

export interface PerpsSnapshot {
  readonly data: PerpsData;
  readonly receivedAt?: number;
}

export interface SnapshotSource {
  fetchSnapshot(signal: AbortSignal): Promise<PerpsSnapshot>;
}

export type CollectionName = Exclude<keyof PerpsData, "orderbooks">;
export type CollectionEntity<K extends CollectionName> = NonNullable<PerpsData[K][string]>;

export type AccountScopedCollection = "positions" | "orders" | "stops" | "twaps";
type ReplaceScopeDelta = {
  [K in AccountScopedCollection]: {
    readonly kind: "replaceScope";
    readonly collection: K;
    readonly accountId: string;
    readonly values: readonly NonNullable<PerpsData[K][string]>[];
  };
}[AccountScopedCollection];

type UpsertDelta = {
  [K in CollectionName]: {
    readonly kind: "upsert";
    readonly collection: K;
    readonly value: CollectionEntity<K>;
  };
}[CollectionName];

type PatchDelta = {
  [K in CollectionName]: {
    readonly kind: "patch";
    readonly collection: K;
    readonly id: string;
    readonly value: Partial<Omit<CollectionEntity<K>, "id">>;
  };
}[CollectionName];

export type PerpsDelta =
  | UpsertDelta
  | PatchDelta
  | ReplaceScopeDelta
  | {
      readonly kind: "remove";
      readonly collection: keyof PerpsData;
      readonly id: string;
    }
  | {
      readonly kind: "orderbook";
      readonly marketId: string;
      readonly bids?: readonly OrderbookLevel[];
      readonly asks?: readonly OrderbookLevel[];
      readonly replace?: boolean;
      readonly nonce: bigint;
      readonly receivedAt?: number;
      readonly raw?: unknown;
    };

export interface StreamHandlers {
  readonly onOpen: () => void;
  readonly onDelta: (delta: PerpsDelta) => void;
  readonly onClose: (reason?: unknown) => void;
  readonly onError: (error: unknown) => void;
}

export interface StreamConnection {
  close(): void;
}

export interface DeltaStream {
  connect(handlers: StreamHandlers): StreamConnection;
}

export interface PerpsStoreOptions {
  readonly snapshotSource: SnapshotSource;
  readonly stream?: DeltaStream;
  readonly reconnectDelayMs?: (attempt: number) => number;
  readonly maxBufferedDeltas?: number;
  readonly onSubscriberError?: (error: unknown) => void;
}

export type StateListener = () => void;

export interface PerpsStore {
  getState(): PerpsState;
  subscribe(listener: StateListener): () => void;
  start(): Promise<void>;
  stop(): void;
  resync(): Promise<void>;
  applyDelta(delta: PerpsDelta): void;
}

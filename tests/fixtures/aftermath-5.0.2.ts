/*
 * Checked against the installed aftermath-ts-sdk@5.0.2 declarations.
 * These fixtures intentionally keep the SDK's REST wrappers and WS field names.
 */

export interface CheckedOrderbook {
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
  asksTotalSize: number;
  bidsTotalSize: number;
  bestBidPrice: number | undefined;
  bestAskPrice: number | undefined;
  midPrice: number | undefined;
  nonce: bigint;
}

export const checkedOrderbooksResponse = {
  orderbooks: [
    {
      orderbook: {
        bids: [{ price: 2, size: 3 }],
        asks: [{ price: 2.1, size: 4 }],
        asksTotalSize: 4,
        bidsTotalSize: 3,
        bestBidPrice: 2,
        bestAskPrice: 2.1,
        midPrice: 2.05,
        nonce: 10n,
      } satisfies CheckedOrderbook,
    },
    {
      orderbook: {
        bids: [{ price: 99, size: 1 }],
        asks: [{ price: 101, size: 2 }],
        asksTotalSize: 2,
        bidsTotalSize: 1,
        bestBidPrice: 99,
        bestAskPrice: 101,
        midPrice: 100,
        nonce: 20n,
      } satisfies CheckedOrderbook,
    },
  ],
} satisfies { orderbooks: { orderbook: CheckedOrderbook }[] };

interface CheckedOrderbookDeltas {
  bidsDeltas: { price: number; size: number }[];
  asksDeltas: { price: number; size: number }[];
  asksTotalSizeDelta: number;
  bidsTotalSizeDelta: number;
  nonce: bigint;
}

export const checkedOrderbookWsMessage = {
  orderbook: {
    marketId: "0xmarket",
    orderbookDeltas: {
      bidsDeltas: [{ price: 2, size: 5 }],
      asksDeltas: [{ price: 2.1, size: 0 }],
      asksTotalSizeDelta: -4,
      bidsTotalSizeDelta: 2,
      nonce: 11n,
    },
  },
} satisfies {
  orderbook: {
    marketId: string;
    orderbookDeltas: CheckedOrderbookDeltas;
  };
};

export const checkedOracleWsMessage = {
  oracle: {
    marketId: "0xmarket",
    basePrice: 2.02,
    collateralPrice: 1,
    markPrice: 2.03,
    bookPrice: 2.025,
  },
} satisfies {
  oracle: {
    marketId: string;
    basePrice: number;
    collateralPrice: number;
    markPrice: number;
    bookPrice?: number;
  };
};

import type { Decimal as DecimalInstance } from "decimal.js";
import {
  Decimal,
  decimalString,
  nonNegativeDecimal,
  positiveDecimal,
} from "./decimal.js";
import type { DecimalValue, Orderbook, OrderbookLevel, Side } from "./types.js";

export interface SimulationRequest {
  readonly side: Side;
  readonly amount: DecimalValue;
  readonly input: "base" | "quote";
  readonly limitPrice?: DecimalValue;
}

export interface SimulatedFill {
  readonly price: string;
  readonly baseAmount: string;
  readonly quoteNotional: string;
}

export interface OrderbookSimulation {
  readonly source: "local-orderbook-estimate";
  readonly marketId: string;
  readonly side: Side;
  readonly input: "base" | "quote";
  readonly requestedInputAmount: string;
  readonly fillableInputAmount: string;
  readonly unfilledInputAmount: string;
  readonly filledBaseAmount: string;
  readonly unfilledBaseAmount: string | null;
  readonly filledQuoteNotional: string;
  readonly unfilledQuoteNotional: string | null;
  readonly bestExecutionPrice: string | null;
  readonly averageExecutionPrice: string | null;
  readonly slippagePercent: string | null;
  readonly fullyFillable: boolean;
  readonly fills: readonly SimulatedFill[];
  readonly warnings: readonly string[];
}

function sortedLevels(orderbook: Orderbook, side: Side): readonly OrderbookLevel[] {
  const levels = side === "buy" ? orderbook.asks : orderbook.bids;
  return [...levels].sort((left, right) => {
    const comparison = positiveDecimal(left.price, "level.price").comparedTo(
      positiveDecimal(right.price, "level.price"),
    );
    return side === "buy" ? comparison : -comparison;
  });
}

function isWithinLimit(
  side: Side,
  price: DecimalInstance,
  limit: DecimalInstance | null,
): boolean {
  if (limit === null) {
    return true;
  }
  return side === "buy" ? price.lte(limit) : price.gte(limit);
}

export function simulateOrderbook(
  orderbook: Orderbook,
  request: SimulationRequest,
): OrderbookSimulation {
  const requested = positiveDecimal(request.amount, "amount");
  const limit =
    request.limitPrice === undefined
      ? null
      : positiveDecimal(request.limitPrice, "limitPrice");
  const levels = sortedLevels(orderbook, request.side);

  let remaining = requested;
  let filledBase = new Decimal(0);
  let filledQuote = new Decimal(0);
  let bestPrice: DecimalInstance | null = null;
  const fills: SimulatedFill[] = [];

  for (const level of levels) {
    if (remaining.isZero()) {
      break;
    }

    const price = positiveDecimal(level.price, "level.price");
    const availableBase = nonNegativeDecimal(level.size, "level.size");
    if (availableBase.isZero() || !isWithinLimit(request.side, price, limit)) {
      continue;
    }

    const quoteAtLevel =
      request.input === "quote"
        ? Decimal.min(availableBase.mul(price), remaining)
        : Decimal.min(availableBase, remaining).mul(price);
    const baseAtLevel =
      request.input === "base"
        ? Decimal.min(availableBase, remaining)
        : quoteAtLevel.div(price);

    if (baseAtLevel.isZero()) {
      continue;
    }

    bestPrice ??= price;
    filledBase = filledBase.add(baseAtLevel);
    filledQuote = filledQuote.add(quoteAtLevel);
    remaining =
      request.input === "base"
        ? Decimal.max(0, remaining.sub(baseAtLevel))
        : Decimal.max(0, remaining.sub(quoteAtLevel));

    fills.push({
      price: decimalString(price),
      baseAmount: decimalString(baseAtLevel),
      quoteNotional: decimalString(quoteAtLevel),
    });
  }

  const filledInput = requested.sub(remaining);
  const average = filledBase.isZero() ? null : filledQuote.div(filledBase);
  const slippage =
    average === null || bestPrice === null
      ? null
      : request.side === "buy"
        ? average.sub(bestPrice).div(bestPrice).mul(100)
        : bestPrice.sub(average).div(bestPrice).mul(100);

  return {
    source: "local-orderbook-estimate",
    marketId: orderbook.marketId,
    side: request.side,
    input: request.input,
    requestedInputAmount: decimalString(requested),
    fillableInputAmount: decimalString(filledInput),
    unfilledInputAmount: decimalString(remaining),
    filledBaseAmount: decimalString(filledBase),
    unfilledBaseAmount: request.input === "base" ? decimalString(remaining) : null,
    filledQuoteNotional: decimalString(filledQuote),
    unfilledQuoteNotional: request.input === "quote" ? decimalString(remaining) : null,
    bestExecutionPrice: bestPrice === null ? null : decimalString(bestPrice),
    averageExecutionPrice: average === null ? null : decimalString(average),
    slippagePercent: slippage === null ? null : decimalString(slippage),
    fullyFillable: remaining.isZero(),
    fills,
    warnings: [
      "Local estimate only; the orderbook may change before execution.",
      "Margin, collateral, liquidation, fees, and protocol validity require an authoritative backend preview.",
    ],
  };
}

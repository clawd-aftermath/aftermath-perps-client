import type { PerpetualsOrderType } from "aftermath-ts-sdk";
import type { Decimal as DecimalInstance } from "decimal.js";
import { decimal, positiveDecimal } from "./decimal.js";
import type { CancelAndPlaceInput } from "./execution.js";

const WIRE_SCALE = 1_000_000_000n;
export interface QuoteIntent {
  readonly side: "buy" | "sell";
  readonly price: string;
  readonly size: string;
  readonly clientOrderId: bigint;
}
export interface MarketMakingLimits {
  /** Human-decimal market.tickSize(), not the scaled marketParams bigint. */
  readonly tickSize: string;
  /** Human-decimal market.lotSize(), not the scaled marketParams bigint. */
  readonly lotSize: string;
  readonly maxOrders: number;
  readonly maxQuoteAgeMs: number;
  readonly maxAbsolutePosition: string;
}
export interface QuoteCycleInput {
  readonly now: number;
  readonly quoteObservedAt: number;
  readonly marketId: string;
  readonly positionSize: string;
  readonly existingOrderIds: readonly bigint[];
  readonly desired: readonly QuoteIntent[];
  readonly orderType: PerpetualsOrderType;
  readonly hasPosition: boolean;
  readonly limits: MarketMakingLimits;
}
export type QuoteCycleResult =
  | { readonly action: "halt"; readonly reason: string }
  | { readonly action: "replace"; readonly input: CancelAndPlaceInput };

function scaled(value: string, quantum: string, label: string): bigint {
  const parsed = positiveDecimal(value, label);
  const step = positiveDecimal(quantum, `${label} quantum`);
  const scaledStep = step.mul(WIRE_SCALE.toString());
  if (!scaledStep.isInteger() || scaledStep.lt(1)) throw new RangeError(`${label} quantum is incompatible with 1e9 wire scaling`);
  if (!parsed.div(step).isInteger()) throw new RangeError(`${label} is not aligned to its quantum`);
  const wire = parsed.mul(WIRE_SCALE.toString());
  if (!wire.isInteger()) throw new RangeError(`${label} cannot be represented with 1e9 wire scaling`);
  return BigInt(wire.toFixed(0));
}
function earlyHalt(input: QuoteCycleInput): string | null {
  if (!Number.isSafeInteger(input.now) || !Number.isSafeInteger(input.quoteObservedAt)) return "timestamps must be safe integer milliseconds";
  if (!Number.isSafeInteger(input.limits.maxQuoteAgeMs) || input.limits.maxQuoteAgeMs < 0) return "maxQuoteAgeMs must be a non-negative safe integer";
  if (!Number.isSafeInteger(input.limits.maxOrders) || input.limits.maxOrders <= 0) return "maxOrders must be a positive safe integer";
  if (input.now < input.quoteObservedAt) return "fair-price timestamp is in the future";
  if (input.now - input.quoteObservedAt > input.limits.maxQuoteAgeMs) return "fair-price input is stale";
  if (input.desired.length === 0) return "no replacement quotes";
  if (input.desired.length > input.limits.maxOrders) return "replacement exceeds maxOrders";
  return null;
}
/** Validates operator-supplied quotes and produces one atomic replacement. */
export function planQuoteCycle(input: QuoteCycleInput): QuoteCycleResult {
  const early = earlyHalt(input);
  if (early !== null) return { action: "halt", reason: early };
  try {
    const position = decimal(input.positionSize, "positionSize");
    const cap = positiveDecimal(input.limits.maxAbsolutePosition, "maxAbsolutePosition");
    if (!position.isZero() && !input.hasPosition) return { action: "halt", reason: "nonzero position requires hasPosition" };
    if (position.abs().gt(cap)) return { action: "halt", reason: "position limit reached" };
    const seen = new Set<bigint>();
    const orders: CancelAndPlaceInput["ordersToPlace"] = [];
    let buySize = decimal(0);
    let sellSize = decimal(0);
    for (const quote of input.desired) {
      if (seen.has(quote.clientOrderId)) return { action: "halt", reason: "duplicate client order id" };
      seen.add(quote.clientOrderId);
      const size = positiveDecimal(quote.size, "size");
      if (quote.side === "buy") buySize = buySize.add(size);
      else sellSize = sellSize.add(size);
      orders.push({ side: quote.side === "buy" ? 0 : 1, price: scaled(quote.price, input.limits.tickSize, "price"), size: scaled(quote.size, input.limits.lotSize, "size"), clientOrderId: quote.clientOrderId });
    }
    if (position.add(buySize).abs().gt(cap) || position.sub(sellSize).abs().gt(cap)) return { action: "halt", reason: "worst-case fill exceeds position limit" };
    const bestBid = input.desired.filter((q) => q.side === "buy").reduce<DecimalInstance | null>((best, q) => {
      const value = positiveDecimal(q.price, "price");
      return best === null || value.gt(best) ? value : best;
    }, null);
    const bestAsk = input.desired.filter((q) => q.side === "sell").reduce<DecimalInstance | null>((best, q) => {
      const value = positiveDecimal(q.price, "price");
      return best === null || value.lt(best) ? value : best;
    }, null);
    if (bestBid && bestAsk && bestBid.gte(bestAsk)) return { action: "halt", reason: "replacement quotes self-cross" };
    return { action: "replace", input: {
      marketId: input.marketId,
      orderIdsToCancel: [...input.existingOrderIds],
      ordersToPlace: orders,
      orderType: input.orderType,
      reduceOnly: false,
      hasPosition: input.hasPosition,
      shouldAbortOnMissingId: false,
    } };
  } catch (error) {
    return { action: "halt", reason: error instanceof Error ? error.message : String(error) };
  }
}

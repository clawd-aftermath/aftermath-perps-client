import type { Decimal as DecimalInstance } from "decimal.js";
import { Decimal as DecimalJs } from "decimal.js";
import type { DecimalValue } from "./types.js";

export const Decimal = DecimalJs.clone({
  precision: 80,
  rounding: DecimalJs.ROUND_HALF_UP,
  toExpNeg: -80,
  toExpPos: 80,
});

const DECIMAL_LITERAL = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;

export function decimal(value: DecimalValue, label = "value"): DecimalInstance {
  const source = value.toString();
  if (!DECIMAL_LITERAL.test(source)) {
    throw new TypeError(`${label} must be a valid decimal`);
  }

  const parsed = new Decimal(source);
  if (!parsed.isFinite()) {
    throw new RangeError(`${label} must be finite`);
  }
  return parsed;
}

export function positiveDecimal(value: DecimalValue, label: string): DecimalInstance {
  const parsed = decimal(value, label);
  if (!parsed.gt(0)) {
    throw new RangeError(`${label} must be greater than zero`);
  }
  return parsed;
}

export function nonNegativeDecimal(value: DecimalValue, label: string): DecimalInstance {
  const parsed = decimal(value, label);
  if (parsed.lt(0)) {
    throw new RangeError(`${label} must be greater than or equal to zero`);
  }
  return parsed;
}

export function decimalString(value: DecimalInstance): string {
  if (value.isZero()) {
    return "0";
  }
  return value.toFixed();
}

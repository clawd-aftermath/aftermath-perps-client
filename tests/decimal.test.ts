import { Decimal as DecimalJs } from "decimal.js";
import { describe, expect, it } from "vitest";
import { Decimal, decimal, nonNegativeDecimal } from "../src/decimal.js";

describe("decimal boundary", () => {
  it("uses a cloned constructor without mutating decimal.js globals", () => {
    const globalPrecision = DecimalJs.precision;
    expect(Decimal).not.toBe(DecimalJs);
    expect(Decimal.precision).toBe(80);
    expect(globalPrecision).toBe(20);
    expect(DecimalJs.precision).toBe(globalPrecision);
  });

  it("accepts decimal notation and negative zero but rejects non-decimal literals", () => {
    expect(decimal("-.5e+2").toString()).toBe("-50");
    expect(nonNegativeDecimal("-0", "value").isZero()).toBe(true);
    for (const invalid of ["0x10", "0b10", "Infinity", "NaN", "1_000", " 1"]) {
      expect(() => decimal(invalid)).toThrow("must be a valid decimal");
    }
  });
});

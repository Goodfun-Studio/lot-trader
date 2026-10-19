import { describe, expect, it } from "bun:test";
import { computeCostBasis, computeFloatingPnl, computeRealizedPnl } from "../src/calc.ts";

describe("Cost basis and PnL Math", () => {
  it("computes cost basis and floating pnl accurately", () => {
    // Buy 1000 shares at 10.00 with 2.00 fee -> cost basis = (10000 + 2) / 1000 = 10.0020
    const costBasis = computeCostBasis(10.00, 1000, 2.00);
    expect(costBasis).toBe(10.0020);

    // Current price 11.50, ETF sell fee 0.02% -> est sell fee = 11.50 * 1000 * 0.0002 = 2.30
    // Market value = 11500, cost = 10002, fee = 2.30 -> PnL = 1495.70
    const [pnl, retRate] = computeFloatingPnl(11.50, costBasis, 1000, 0.0002);
    expect(pnl).toBe(1495.70);
    // Return rate = 1495.70 / 10002 = 0.14954... -> 0.1495 (14.95%)
    expect(retRate).toBe(0.1495);
  });
});


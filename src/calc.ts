/**
 * Pure calculation functions for Lot Trader engine.
 */

export const DEFAULT_ETF_SELL_FEE_RATE = 0.0002;   // 0.02% (no stamp duty)
export const DEFAULT_STOCK_SELL_FEE_RATE = 0.0007; // 0.05% stamp duty + 0.02% commission

export function round(val: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  // Math.round to match Decimal ROUND_HALF_UP behavior
  return Math.round((val + Number.EPSILON) * factor) / factor;
}

export function getSellFeeRate(assetClass: string): number {
  if (assetClass.toUpperCase() === "ETF" || assetClass.toUpperCase() === "GOLD_SPOT") {
    return DEFAULT_ETF_SELL_FEE_RATE;
  }
  return DEFAULT_STOCK_SELL_FEE_RATE;
}

/**
 * P_cost = (Q_buy * P_buy + Fee_buy) / Q_buy
 */
export function computeCostBasis(buyPrice: number, buyQuantity: number, buyFee: number): number {
  const totalCost = buyPrice * buyQuantity + buyFee;
  const costBasis = totalCost / buyQuantity;
  return round(costBasis, 4);
}

/**
 * Calculates floating PnL and floating return rate.
 * Returns: [floating_pnl, floating_return_rate]
 */
export function computeFloatingPnl(
  currentPrice: number,
  costBasis: number,
  remainingQuantity: number,
  sellFeeRate: number = DEFAULT_ETF_SELL_FEE_RATE
): [number, number] {
  const marketValue = currentPrice * remainingQuantity;
  const holdingCost = costBasis * remainingQuantity;
  const estSellFee = marketValue * sellFeeRate;
  const floatingPnl = marketValue - holdingCost - estSellFee;

  let returnRate = 0;
  if (holdingCost > 0) {
    returnRate = floatingPnl / holdingCost;
  }

  return [round(floatingPnl, 2), round(returnRate, 4)];
}

/**
 * Realized PnL = (P_close * Q_close) - (P_cost * Q_close) - close_fee
 */
export function computeRealizedPnl(
  closePrice: number,
  costBasis: number,
  closeQuantity: number,
  closeFee: number
): number {
  const grossProceeds = closePrice * closeQuantity;
  const costBasisTotal = costBasis * closeQuantity;
  const netPnl = grossProceeds - costBasisTotal - closeFee;
  return round(netPnl, 2);
}


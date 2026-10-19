/**
 * Position / Holding aggregation domain logic.
 */
import { Database } from "bun:sqlite";
import { LotStatus } from "./models.ts";
import { computeFloatingPnl, getSellFeeRate, round } from "./calc.ts";
import { SettlementArbitrator } from "./settlement.ts";
import { QuoteProvider, normalizeSymbol } from "./quotes.ts";

export interface PositionSummary {
  symbol: string;
  name: string;
  asset_class: string;
  settlement_mode: string;
  total_quantity: number;
  available_core_qty: number;
  total_cost_basis: number;
  avg_cost_price: number;
  current_price: number;
  market_value: number;
  total_floating_pnl: number;
  overall_return_rate: number;
  portfolio_weight: number;
  active_lots_count: number;
  target_tp_10: number;
  target_tp_20: number;
  target_dip_10: number;
  target_dip_20: number;
}

export class PositionAggregator {
  private conn: Database;
  private quoteProvider: QuoteProvider;
  private arbitrator: SettlementArbitrator;

  constructor(dbConn: Database, quoteProvider?: QuoteProvider) {
    this.conn = dbConn;
    this.quoteProvider = quoteProvider || new QuoteProvider();
    this.arbitrator = new SettlementArbitrator(dbConn);
  }

  public async getPositionSummaries(symbolFilter?: string, asOfTime?: Date): Promise<PositionSummary[]> {
    const now = asOfTime || new Date();

    let query = "SELECT * FROM lots WHERE status = 'ACTIVE'";
    const params: any[] = [];
    if (symbolFilter) {
      const [stdSymbol] = normalizeSymbol(symbolFilter);
      query += " AND symbol = ?";
      params.push(stdSymbol);
    }
    query += " ORDER BY symbol ASC, buy_time ASC";

    const activeLots = this.conn.query<any, any[]>(query).all(...params);
    if (!activeLots || activeLots.length === 0) {
      return [];
    }

    // Group lots by symbol
    const symbolLotsMap = new Map<string, any[]>();
    for (const lot of activeLots) {
      const sym = lot.symbol;
      if (!symbolLotsMap.has(sym)) {
        symbolLotsMap.set(sym, []);
      }
      symbolLotsMap.get(sym)!.push(lot);
    }

    // Fetch quotes for all symbols
    const uniqueSymbols = Array.from(symbolLotsMap.keys());
    const quotes = await this.quoteProvider.getQuotes(uniqueSymbols);

    interface PrePosition {
      symbol: string;
      name: string;
      asset_class: string;
      settlement_mode: string;
      total_quantity: number;
      available_core_qty: number;
      total_cost_basis: number;
      avg_cost_price: number;
      current_price: number;
      market_value: number;
      total_floating_pnl: number;
      overall_return_rate: number;
      active_lots_count: number;
      target_tp_10: number;
      target_tp_20: number;
      target_dip_10: number;
      target_dip_20: number;
    }

    const prePositions: PrePosition[] = [];
    let portfolioTotalMarketValue = 0;

    for (const [sym, lots] of symbolLotsMap.entries()) {
      const symRow = this.conn.query<{
        name: string;
        asset_class: string;
        settlement_mode: string;
      }, [string]>("SELECT name, asset_class, settlement_mode FROM symbols WHERE symbol = ?").get(sym);

      const name = symRow ? symRow.name : sym;
      const assetClass = symRow ? symRow.asset_class : "ETF";
      const settlementMode = symRow ? symRow.settlement_mode : "STATUTORY_T1";
      const feeRate = getSellFeeRate(assetClass);

      let totalQty = 0;
      let totalCostBasis = 0;

      for (const lot of lots) {
        const remQty = Number(lot.remaining_quantity);
        const unitCost = Number(lot.cost_basis_unit);
        totalQty += remQty;
        totalCostBasis += remQty * unitCost;
      }

      const q = quotes[sym];
      // Current price falls back to last lot buy_price if quote is 0 or unavailable
      const currentPrice = (q && q.current_price > 0) ? q.current_price : Number(lots[lots.length - 1].buy_price);

      const avgCostPrice = totalQty > 0 ? round(totalCostBasis / totalQty, 4) : 0;
      const marketValue = round(currentPrice * totalQty, 2);

      // Available core quantity
      let availableCoreQty = 0;
      if (settlementMode === "NATIVE_T0") {
        availableCoreQty = totalQty;
      } else {
        availableCoreQty = this.arbitrator.computeAvailableCorePosition(sym, now);
      }

      // Floating PnL & return rate
      const [floatingPnl, returnRate] = computeFloatingPnl(
        currentPrice,
        avgCostPrice,
        totalQty,
        feeRate
      );

      // Key decision price lines based on avg_cost_price
      const targetTp10 = round(avgCostPrice * 1.10, 4);
      const targetTp20 = round(avgCostPrice * 1.20, 4);
      const targetDip10 = round(avgCostPrice * 0.90, 4);
      const targetDip20 = round(avgCostPrice * 0.80, 4);

      prePositions.push({
        symbol: sym,
        name,
        asset_class: assetClass,
        settlement_mode: settlementMode,
        total_quantity: totalQty,
        available_core_qty: availableCoreQty,
        total_cost_basis: round(totalCostBasis, 2),
        avg_cost_price: avgCostPrice,
        current_price: currentPrice,
        market_value: marketValue,
        total_floating_pnl: floatingPnl,
        overall_return_rate: returnRate,
        active_lots_count: lots.length,
        target_tp_10: targetTp10,
        target_tp_20: targetTp20,
        target_dip_10: targetDip10,
        target_dip_20: targetDip20,
      });

      portfolioTotalMarketValue += marketValue;
    }

    // Second pass: compute portfolio_weight
    const results: PositionSummary[] = prePositions.map((pos) => {
      let weight = 0;
      if (portfolioTotalMarketValue > 0) {
        weight = round(pos.market_value / portfolioTotalMarketValue, 4);
      }
      return {
        ...pos,
        portfolio_weight: weight,
      };
    });

    return results;
  }
}

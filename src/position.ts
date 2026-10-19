/**
 * Position / Holding aggregation domain logic.
 * Deeply aligned with InvestmentTracker hierarchical portfolio profit & loss architecture.
 */
import { Database } from "bun:sqlite";
import { LotStatus } from "./models.ts";
import { computeFloatingPnl, getSellFeeRate, round } from "./calc.ts";
import { SettlementArbitrator } from "./settlement.ts";
import { QuoteProvider, normalizeSymbol } from "./quotes.ts";

export interface LotListItem {
  lot_id: string;
  symbol: string;
  symbol_name: string;
  settlement_mode: string;
  buy_time: string;
  buy_price: number;
  buy_quantity: number;
  remaining_quantity: number;
  cost_basis_unit: number;
  current_price: number;
  floating_pnl: number;
  return_rate: number;
  status: string;
  pyramid_level: number;
  can_sell_now: boolean;
  is_day_trading: boolean;
  peak_price?: number | null;
  trailing_stop_active?: boolean;
  realized_pnl: number;
}

export interface PortfolioSummaryView {
  total_cost: number;
  total_market_value: number;
  total_floating_pnl: number;
  overall_return_rate: number;
  full_position_cap: number; // 默认 50000
  total_active_lots: number;
  total_symbols_count: number;
}

export interface TargetHoldingView {
  symbol: string;
  name: string;
  asset_class: string;
  settlement_mode: string;
  current_price: number;
  total_quantity: number;
  available_core_qty: number;
  total_cost_basis: number;
  avg_cost_price: number;
  market_value: number;
  total_floating_pnl: number;
  overall_return_rate: number;
  cost_position_rate: number;      // total_cost_basis / full_position_cap
  current_position_rate: number;   // market_value / full_position_cap
  portfolio_weight: number;        // market_value / portfolio_total_market_value
  last_buy_price: number;
  recommended_buy_in_point: number;  // last_buy_price * 0.90
  recommended_sale_out_point: number; // last_buy_price * 1.10
  lots: LotListItem[];             // 归属于该标的的全部活跃批次
  // Backward compatibility fields
  active_lots_count: number;
  target_tp_10: number;
  target_tp_20: number;
  target_dip_10: number;
  target_dip_20: number;
}

export interface PositionHierarchicalView {
  portfolio_summary: PortfolioSummaryView;
  targets: TargetHoldingView[];
}

// Backward compatibility interface
export type PositionSummary = TargetHoldingView;

export class PositionAggregator {
  private conn: Database;
  private quoteProvider: QuoteProvider;
  private arbitrator: SettlementArbitrator;
  private fullPositionCap: number;

  constructor(dbConn: Database, quoteProvider?: QuoteProvider, fullPositionCap?: number) {
    this.conn = dbConn;
    this.quoteProvider = quoteProvider || new QuoteProvider();
    this.arbitrator = new SettlementArbitrator(dbConn);

    let cap = fullPositionCap;
    if (cap === undefined && process.env.LOT_TRADER_FULL_POSITION_CAP) {
      cap = parseFloat(process.env.LOT_TRADER_FULL_POSITION_CAP);
    }
    this.fullPositionCap = cap && cap > 0 ? cap : 50000;
  }

  public getFullPositionCap(): number {
    return this.fullPositionCap;
  }

  public setFullPositionCap(cap: number): void {
    if (cap > 0) {
      this.fullPositionCap = cap;
    }
  }

  /**
   * Retrieves the full 3-layer hierarchical position view:
   * Layer 1: Portfolio Summary
   * Layer 2: Symbol Holdings with dual position rates & decision points
   * Layer 3: Nested Active Lots Breakdown
   */
  public async getHierarchicalPositionView(
    symbolFilter?: string,
    asOfTime?: Date,
    customFullPositionCap?: number
  ): Promise<PositionHierarchicalView> {
    const now = asOfTime || new Date();
    const cap = customFullPositionCap && customFullPositionCap > 0 ? customFullPositionCap : this.fullPositionCap;
    const nowDateStr = now.toISOString().slice(0, 10);

    let query = "SELECT * FROM lots WHERE status = 'ACTIVE'";
    const params: any[] = [];
    if (symbolFilter) {
      const [stdSymbol] = normalizeSymbol(symbolFilter);
      query += " AND symbol = ?";
      params.push(stdSymbol);
    }
    query += " ORDER BY symbol ASC, datetime(buy_time) ASC";

    const activeLots = this.conn.query<any, any[]>(query).all(...params);
    if (!activeLots || activeLots.length === 0) {
      return {
        portfolio_summary: {
          total_cost: 0,
          total_market_value: 0,
          total_floating_pnl: 0,
          overall_return_rate: 0,
          full_position_cap: cap,
          total_active_lots: 0,
          total_symbols_count: 0,
        },
        targets: [],
      };
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

    let portfolioTotalCost = 0;
    let portfolioTotalMarketValue = 0;
    let portfolioTotalFloatingPnl = 0;
    let portfolioTotalActiveLots = 0;

    const targetsPre: TargetHoldingView[] = [];

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
      let lastBuyPrice = 0;
      let lastBuyTime = "";

      const nestedLots: LotListItem[] = [];

      const q = quotes[sym];
      // Current price falls back to last lot buy_price if quote is 0 or unavailable
      const fallbackPrice = Number(lots[lots.length - 1].buy_price);
      const currentPrice = q && q.current_price > 0 ? q.current_price : fallbackPrice;

      // Available core quantity
      let availableCoreQty = 0;
      if (settlementMode === "NATIVE_T0") {
        // Will set after totalQty is summed
      } else {
        availableCoreQty = this.arbitrator.computeAvailableCorePosition(sym, now);
      }

      for (const lot of lots) {
        const remQty = Number(lot.remaining_quantity);
        const unitCost = Number(lot.cost_basis_unit);
        const buyP = Number(lot.buy_price);
        const buyT = lot.buy_time;

        totalQty += remQty;
        totalCostBasis += remQty * unitCost;

        if (!lastBuyTime || buyT >= lastBuyTime) {
          lastBuyTime = buyT;
          lastBuyPrice = buyP;
        }

        const [lotFloatPnl, lotRetRate] = computeFloatingPnl(currentPrice, unitCost, remQty, feeRate);

        const bDateStr = buyT.slice(0, 10);
        let dynamicCanSell = false;
        if (settlementMode === "NATIVE_T0") {
          dynamicCanSell = true;
        } else if (bDateStr < nowDateStr) {
          dynamicCanSell = true;
        } else {
          dynamicCanSell = availableCoreQty >= remQty;
        }

        nestedLots.push({
          lot_id: lot.lot_id,
          symbol: sym,
          symbol_name: name,
          settlement_mode: settlementMode,
          buy_time: buyT,
          buy_price: buyP,
          buy_quantity: lot.buy_quantity,
          remaining_quantity: remQty,
          cost_basis_unit: unitCost,
          current_price: currentPrice,
          floating_pnl: lotFloatPnl,
          return_rate: lotRetRate,
          status: lot.status,
          pyramid_level: lot.pyramid_level,
          can_sell_now: dynamicCanSell,
          is_day_trading: Boolean(lot.is_day_trading),
          peak_price: lot.peak_price ? Number(lot.peak_price) : null,
          trailing_stop_active: Boolean(lot.trailing_stop_active),
          realized_pnl: Number(lot.realized_pnl || 0),
        });
      }

      if (settlementMode === "NATIVE_T0") {
        availableCoreQty = totalQty;
      }

      const avgCostPrice = totalQty > 0 ? round(totalCostBasis / totalQty, 4) : 0;
      const marketValue = round(currentPrice * totalQty, 2);

      const [floatingPnl, returnRate] = computeFloatingPnl(
        currentPrice,
        avgCostPrice,
        totalQty,
        feeRate
      );

      // Dual position rates against full_position_cap
      const costPositionRate = cap > 0 ? round(totalCostBasis / cap, 4) : 0;
      const currentPositionRate = cap > 0 ? round(marketValue / cap, 4) : 0;

      // Recommended trade points based on last buy price
      const recommendedBuyInPoint = round(lastBuyPrice * 0.90, 4);
      const recommendedSaleOutPoint = round(lastBuyPrice * 1.10, 4);

      // Key decision price lines based on avg_cost_price
      const targetTp10 = round(avgCostPrice * 1.10, 4);
      const targetTp20 = round(avgCostPrice * 1.20, 4);
      const targetDip10 = round(avgCostPrice * 0.90, 4);
      const targetDip20 = round(avgCostPrice * 0.80, 4);

      targetsPre.push({
        symbol: sym,
        name,
        asset_class: assetClass,
        settlement_mode: settlementMode,
        current_price: currentPrice,
        total_quantity: totalQty,
        available_core_qty: availableCoreQty,
        total_cost_basis: round(totalCostBasis, 2),
        avg_cost_price: avgCostPrice,
        market_value: marketValue,
        total_floating_pnl: floatingPnl,
        overall_return_rate: returnRate,
        cost_position_rate: costPositionRate,
        current_position_rate: currentPositionRate,
        portfolio_weight: 0, // calculated in second pass
        last_buy_price: lastBuyPrice,
        recommended_buy_in_point: recommendedBuyInPoint,
        recommended_sale_out_point: recommendedSaleOutPoint,
        lots: nestedLots,
        active_lots_count: lots.length,
        target_tp_10: targetTp10,
        target_tp_20: targetTp20,
        target_dip_10: targetDip10,
        target_dip_20: targetDip20,
      });

      portfolioTotalCost += totalCostBasis;
      portfolioTotalMarketValue += marketValue;
      portfolioTotalFloatingPnl += floatingPnl;
      portfolioTotalActiveLots += lots.length;
    }

    portfolioTotalCost = round(portfolioTotalCost, 2);
    portfolioTotalMarketValue = round(portfolioTotalMarketValue, 2);
    portfolioTotalFloatingPnl = round(portfolioTotalFloatingPnl, 2);
    const overallReturnRate = portfolioTotalCost > 0 ? round(portfolioTotalFloatingPnl / portfolioTotalCost, 4) : 0;

    // Calculate portfolio_weight for each target
    const targets: TargetHoldingView[] = targetsPre.map((t) => {
      let weight = 0;
      if (portfolioTotalMarketValue > 0) {
        weight = round(t.market_value / portfolioTotalMarketValue, 4);
      }
      return {
        ...t,
        portfolio_weight: weight,
      };
    });

    // Sort targets by cost_position_rate descending (matching InvestmentTracker)
    targets.sort((a, b) => b.cost_position_rate - a.cost_position_rate);

    return {
      portfolio_summary: {
        total_cost: portfolioTotalCost,
        total_market_value: portfolioTotalMarketValue,
        total_floating_pnl: portfolioTotalFloatingPnl,
        overall_return_rate: overallReturnRate,
        full_position_cap: cap,
        total_active_lots: portfolioTotalActiveLots,
        total_symbols_count: targets.length,
      },
      targets,
    };
  }

  /**
   * Backward-compatible method returning flat list of TargetHoldingView (PositionSummary[]).
   */
  public async getPositionSummaries(symbolFilter?: string, asOfTime?: Date): Promise<PositionSummary[]> {
    const view = await this.getHierarchicalPositionView(symbolFilter, asOfTime);
    return view.targets;
  }
}

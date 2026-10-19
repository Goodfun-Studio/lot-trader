import { describe, expect, it } from "bun:test";
import { AppDatabase } from "../src/db.ts";
import { TraderEngine } from "../src/engine.ts";
import { QuoteProvider } from "../src/quotes.ts";
import { LotStatus, SignalType, TradeAction } from "../src/models.ts";

function createTestEngine(): { engine: TraderEngine; mockQuotes: QuoteProvider; db: AppDatabase } {
  const db = new AppDatabase(":memory:");
  const mockQuotes = new QuoteProvider();
  const engine = new TraderEngine(db.getConnection(), mockQuotes);
  return { engine, mockQuotes, db };
}

describe("Trader Engine", () => {
  it("validates lot buy parameters correctly", () => {
    const { engine } = createTestEngine();

    // Qty not multiple of 100 must fail
    expect(() => engine.buyLot("518880.SH", 6.00, 150)).toThrow("100 的整数倍");

    // Negative or zero qty must fail
    expect(() => engine.buyLot("518880.SH", 6.00, -100)).toThrow("大于 0");

    // Valid buy
    const lot = engine.buyLot("518880.SH", 6.120, 2000);
    expect(lot.lot_id.startsWith("LOT-")).toBe(true);
    expect(lot.symbol).toBe("518880.SH");
    expect(lot.remaining_quantity).toBe(2000);
    expect(lot.status).toBe(LotStatus.ACTIVE);
    expect(lot.can_sell_now).toBe(true); // Native T+0 is immediately sellable
  });

  it("scene a: deep value alert preserves ACTIVE status strictly", async () => {
    /**
     * 测试场景 a): 单笔批次跌幅达 -22%，系统保持 ACTIVE 并正确出具 DEEP_VALUE_ALERT 深跌等待加仓信号；
     * 铁律：严禁冻结，绝不锁死！
     */
    const { engine, mockQuotes } = createTestEngine();

    // Buy at 10.00
    const lot = engine.buyLot("588000.SH", 10.00, 1000);
    expect(lot.status).toBe(LotStatus.ACTIVE);

    // Price drops to 7.70 (-23% return)
    mockQuotes.setMockPrice("588000.SH", 7.70);

    const signals = await engine.scanSignals();
    expect(signals.length).toBe(1);
    const sig = signals[0];
    expect(sig.signal_type).toBe(SignalType.DEEP_VALUE_ALERT);
    expect(sig.suggested_action).toBe("DEEP_VALUE_ACCUMULATE_ON_STABILIZE");
    expect(sig.trigger_return_rate).toBeLessThan(-0.20);

    // Verify lot in database is STILL ACTIVE (Never frozen)
    const reloadedLot = engine.getLot(lot.lot_id);
    expect(reloadedLot).not.toBeNull();
    expect(reloadedLot!.status).toBe(LotStatus.ACTIVE);
  });

  it("scene b: gold etf native T+0 profit take", async () => {
    /**
     * 测试场景 b): 黄金 ETF 买入当日浮盈 +10%，即刻生成平仓信号并闭环；
     */
    const { engine, mockQuotes } = createTestEngine();

    // Buy Gold ETF today at 6.00
    const lot = engine.buyLot("518880.SH", 6.00, 2000);
    expect(lot.can_sell_now).toBe(true);

    // Price jumps to 6.70 (+11.6% return)
    mockQuotes.setMockPrice("518880.SH", 6.70);

    const signals = await engine.scanSignals();
    expect(signals.length).toBe(1);
    const sig = signals[0];
    expect(sig.signal_type).toBe(SignalType.TAKE_PROFIT_ALERT);
    expect(sig.suggested_action).toBe("CLOSE_PROFIT");

    // Close the lot
    const [updatedLot, trade] = engine.closeLot(lot.lot_id, 6.70);
    expect(updatedLot.status).toBe(LotStatus.CLOSED);
    expect(updatedLot.remaining_quantity).toBe(0);
    expect(updatedLot.is_day_trading).toBe(true); // Native T+0 closed today
    expect(trade.action).toBe(TradeAction.SELL_DAY_TRADE);
    expect(trade.realized_pnl).toBeGreaterThan(1300.00);
  });

  it("scene c: stock core substitution day trade", async () => {
    /**
     * 测试场景 c): 股票有可用底仓情况下，盘中买入新 Lot 浮盈 +10%，成功触发底仓代冲日内止盈；
     */
    const { engine, mockQuotes } = createTestEngine();

    // Yesterday bought 500 shares of 600519
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    const coreLot = engine.buyLot("600519.SH", 1500.00, 500, undefined, twoDaysAgo);

    // Today bought another 500 shares at 1500.00
    const todayLot = engine.buyLot("600519.SH", 1500.00, 500);

    // Stock surges to 1670.00 (+11.3%)
    mockQuotes.setMockPrice("600519.SH", 1670.00);

    // Scan signals
    const signals = await engine.scanSignals();
    const todaySig = signals.find((s) => s.lot_id === todayLot.lot_id);
    expect(todaySig).toBeDefined();
    expect(todaySig!.signal_type).toBe(SignalType.DAY_TRADE_PROFIT_ALERT);
    expect(todaySig!.suggested_action).toBe("SUBSTITUTE_CORE_CLOSE");

    // Close today's lot using substitute core
    const [updatedLot, trade] = engine.closeLot(
      todayLot.lot_id,
      1670.00,
      undefined,
      true // substituteCore
    );
    expect(updatedLot.status).toBe(LotStatus.CLOSED);
    expect(updatedLot.is_day_trading).toBe(true);
    expect(updatedLot.substituted_core_lot_id).toBe(coreLot.lot_id);
    expect(trade.action).toBe(TradeAction.SELL_DAY_TRADE);
    expect(trade.realized_pnl).toBeGreaterThan(80000.00);
  });

  it("scene d: stock no core position T+1 lock", async () => {
    /**
     * 测试场景 d): 股票首日建仓（无底仓）盘中浮盈 +10%，正确阻断当日卖出指令，提示 T+1 锁定待次日执行；
     */
    const { engine, mockQuotes } = createTestEngine();

    // Today bought first position in 000001 (no prior core position)
    const lot = engine.buyLot("000001.SZ", 10.00, 1000);

    // Price jumps to 11.20 (+12%)
    mockQuotes.setMockPrice("000001.SZ", 11.20);

    const signals = await engine.scanSignals();
    expect(signals.length).toBe(1);
    const sig = signals[0];
    // Must report T1_LOCKED_ALERT
    expect(sig.signal_type).toBe(SignalType.T1_LOCKED_ALERT);
    expect(sig.suggested_action).toBe("HOLD_UNTIL_NEXT_TRADING_DAY");

    // Direct close attempt without substitute_core must be blocked
    expect(() => engine.closeLot(lot.lot_id, 11.20, undefined, false)).toThrow(
      "法定 T+1，当日买入份额无法直接平仓"
    );

    // Attempting substitute-core when core position is 0 must fail (No Naked Short Selling!)
    expect(() => engine.closeLot(lot.lot_id, 11.20, undefined, true)).toThrow(
      "底仓可用配额不足，严防裸卖空"
    );
  });

  it("handles partial close properly", () => {
    const { engine } = createTestEngine();
    const lot = engine.buyLot("518880.SH", 6.00, 2000);

    // Partial close 1000 shares
    const [updatedLot, trade] = engine.closeLot(lot.lot_id, 6.60, 1000);
    expect(updatedLot.remaining_quantity).toBe(1000);
    expect(updatedLot.status).toBe(LotStatus.ACTIVE);
    expect(trade.quantity).toBe(1000);

    // Close remaining 1000 shares
    const [finalLot, finalTrade] = engine.closeLot(lot.lot_id, 6.80, 1000);
    expect(finalLot.remaining_quantity).toBe(0);
    expect(finalLot.status).toBe(LotStatus.CLOSED);
  });

  it("computes stats accurately", () => {
    const { engine } = createTestEngine();
    const lot1 = engine.buyLot("518880.SH", 6.00, 1000);
    engine.closeLot(lot1.lot_id, 6.60); // Win

    const lot2 = engine.buyLot("518880.SH", 6.00, 1000);
    engine.closeLot(lot2.lot_id, 5.50); // Loss

    const stats = engine.computeStats();
    expect(stats.total_trades).toBe(2);
    expect(stats.winning_trades).toBe(1);
    expect(stats.losing_trades).toBe(1);
    expect(stats.win_rate).toBe(0.5);
    expect(stats.total_realized_pnl).toBeGreaterThan(0);
  });
});


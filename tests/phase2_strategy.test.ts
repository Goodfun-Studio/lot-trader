import { describe, expect, it } from "bun:test";
import { AppDatabase } from "../src/db.ts";
import { TraderEngine } from "../src/engine.ts";
import { QuoteProvider } from "../src/quotes.ts";
import { LotStatus, SignalType, TradeAction } from "../src/models.ts";

function createTestEngine(portfolioBudget?: number): {
  engine: TraderEngine;
  mockQuotes: QuoteProvider;
  db: AppDatabase;
} {
  const db = new AppDatabase(":memory:");
  const mockQuotes = new QuoteProvider();
  const engine = new TraderEngine(db.getConnection(), mockQuotes, portfolioBudget);
  return { engine, mockQuotes, db };
}

describe("Phase 2 Core Strategy Logic Tests", () => {
  it("pyramid dip add: correctly inherits lineage, calculates amount, and increments pyramid level", () => {
    const { engine } = createTestEngine();

    // 1. Initial base lot buy, backfilled 72h into the past (D-01: --time may never be in the
    // future, so tests express "history" with real past timestamps).
    const baseLot = engine.buyLot("518880.SH", 6.00, 2000, undefined, new Date(Date.now() - 72 * 3600 * 1000));
    expect(baseLot.pyramid_level).toBe(0);
    expect(baseLot.parent_lot_id).toBeNull();

    // 2. Add lot via trade lot add primitive (default base amount = 10,000 yuan)
    // At price 5.40, 10000 / 5.40 = 1851.85 -> 1800 shares (nearest 100-share lot)
    // Backfilled -49h: the root lot is exempt from the cooldown, so this tier is legal.
    const addTime = new Date(Date.now() - 49 * 3600 * 1000);
    const addedLot = engine.addLot(baseLot.lot_id, 5.40, {
      amount: 10000,
      buyTime: addTime,
    });

    expect(addedLot.parent_lot_id).toBe(baseLot.lot_id);
    expect(addedLot.pyramid_level).toBe(1);
    expect(addedLot.symbol).toBe("518880.SH");
    expect(addedLot.buy_price).toBe(5.40);
    expect(addedLot.buy_quantity).toBe(1800);
    expect(addedLot.status).toBe(LotStatus.ACTIVE);

    // 3. Add second tier (L2) with explicit qty, on the REAL clock: the lineage's last non-root
    // addition was 49h ago, i.e. already outside the 48h cooldown window.
    const addedLot2 = engine.addLot(addedLot.lot_id, 4.80, {
      qty: 2500,
    });

    expect(addedLot2.parent_lot_id).toBe(addedLot.lot_id);
    expect(addedLot2.pyramid_level).toBe(2);
    expect(addedLot2.buy_quantity).toBe(2500);
  });

  it("lineage guard: anti-shake cooldown intercepts rapid dip additions within 48 hours", () => {
    const { engine } = createTestEngine();
    const nowMs = Date.now();

    // Initial lot backfilled 120h into the past. D-01: the window is measured against the REAL
    // clock, so the past fills below are legal history rather than clock forgeries.
    const baseLot = engine.buyLot("518880.SH", 6.00, 2000, undefined, new Date(nowMs - 120 * 3600 * 1000));

    // First dip addition 1 real hour ago: no non-root lot existed yet in this lineage, so it is legal.
    const lotL1 = engine.addLot(baseLot.lot_id, 5.40, {
      amount: 10000,
      buyTime: new Date(nowMs - 1 * 3600 * 1000),
    });
    expect(lotL1.pyramid_level).toBe(1);

    // Rapid second dip addition on the real clock, only ~1h after the L1 add -> inside the window.
    expect(() => {
      engine.addLot(baseLot.lot_id, 5.00, {
        amount: 10000,
      });
    }).toThrow("防抖冷却窗口守卫拦截");

    // Also adding from the child lot inside the window must be intercepted.
    expect(() => {
      engine.addLot(lotL1.lot_id, 5.00, {
        amount: 10000,
      });
    }).toThrow("防抖冷却窗口守卫拦截");

    // Addition after 48 real hours must succeed: parent backfilled -72h, first add -49h, then the
    // next tier on the real clock (49h later, i.e. outside the window).
    const { engine: agedEngine } = createTestEngine();
    const agedBase = agedEngine.buyLot("518880.SH", 6.00, 2000, undefined, new Date(nowMs - 72 * 3600 * 1000));
    const agedL1 = agedEngine.addLot(agedBase.lot_id, 5.00, {
      amount: 10000,
      buyTime: new Date(nowMs - 49 * 3600 * 1000),
    });
    expect(agedL1.pyramid_level).toBe(1);

    const lotL2 = agedEngine.addLot(agedL1.lot_id, 5.00, {
      amount: 10000,
    });
    expect(lotL2.pyramid_level).toBe(2);
  });

  it("dynamic trailing stop: activates at +15% and triggers on 3% pullback from peak", async () => {
    const { engine, mockQuotes } = createTestEngine();

    // Buy ETF at 10.00
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    const lot = engine.buyLot("510300.SH", 10.00, 1000, undefined, yesterday);
    expect(lot.status).toBe(LotStatus.ACTIVE);

    // 1. Price rises to 11.20 (+12%): triggers regular TAKE_PROFIT_ALERT (+10%), trailing stop NOT active yet
    mockQuotes.setMockPrice("510300.SH", 11.20);
    let signals = await engine.scanSignals();
    expect(signals.length).toBe(1);
    expect(signals[0].signal_type).toBe(SignalType.TAKE_PROFIT_ALERT);

    // Verify trailing_stop_active is still false in DB
    let reloaded = engine.getLot(lot.lot_id)!;
    expect(reloaded.trailing_stop_active).toBe(false);

    // 2. Price surges to 11.80 (+18%): exceeds activation line (+15%), activates trailing stop!
    mockQuotes.setMockPrice("510300.SH", 11.80);
    signals = await engine.scanSignals();
    reloaded = engine.getLot(lot.lot_id)!;
    expect(reloaded.trailing_stop_active).toBe(true);
    expect(reloaded.peak_price).toBe(11.80);

    // 3. Price pulls back from peak 11.80 to 11.40 (pullback: (11.80 - 11.40) / 11.80 = 3.39% >= 3%)
    mockQuotes.setMockPrice("510300.SH", 11.40);
    signals = await engine.scanSignals();
    expect(signals.length).toBe(1);
    const trailingSig = signals[0];
    expect(trailingSig.signal_type).toBe(SignalType.TRAILING_STOP_ALERT);
    expect(trailingSig.suggested_action).toBe("TRAILING_STOP_CLOSE");
    expect(trailingSig.trigger_price).toBe(11.40);
    const payload = JSON.parse(trailingSig.payload_json);
    expect(payload.peak_price).toBe(11.80);
    expect(payload.pullback_rate).toBeGreaterThanOrEqual(0.03);
    // Text hygiene (mojibake guard): the reason is a clean ASCII description, never `â...`.
    expect(payload.reason).toContain("dynamic trailing stop triggered");
    expect(payload.reason).not.toContain("\u00e2");
    expect(payload.reason).not.toContain("\ufffd");
  });

  it("dip ladder signal reason is well-formed (no mojibake, no stray `%i`)", async () => {
    const { engine, mockQuotes } = createTestEngine();
    engine.buyLot("510300.SH", 10.0, 1000, undefined, new Date(Date.now() - 24 * 3600 * 1000));
    mockQuotes.setMockPrice("510300.SH", 8.8); // -12%: inside the regular dip ladder (-10% ~ -20%)

    const signals = await engine.scanSignals();
    const dipSig = signals.find((s) => s.signal_type === SignalType.ADD_POSITION_ALERT);
    expect(dipSig).toBeDefined();
    const payload = JSON.parse(dipSig!.payload_json);
    expect(payload.reason).toContain("Regular dip ladder reached");
    expect(payload.reason).not.toContain("%i");
    expect(payload.reason).not.toContain("\u00e2");
    expect(payload.reason).toMatch(/\(-?\d+\.\d{2}%\)$/);
  });

  it("position cap & risk guard: blocks purchases exceeding 30% single-symbol limit", () => {
    // Portfolio with 100,000 budget
    const { engine } = createTestEngine(100000);

    // 1. Buy 20,000 yuan of 518880.SH (20% of 100k budget) -> Allowed
    const lot1 = engine.buyLot("518880.SH", 6.00, 3300); // 19,800 yuan
    expect(lot1.lot_id.startsWith("LOT-")).toBe(true);

    // 2. Buy another 20,000 yuan of 518880.SH (total 39,800 yuan = 39.8% > 30% cap) -> Must be blocked!
    expect(() => {
      engine.buyLot("518880.SH", 6.00, 3300);
    }).toThrow("单标的持仓硬顶风控拦截");

    // 3. Buy 25,000 yuan of another symbol 600519.SH (25% <= 30%) -> Allowed
    const lot2 = engine.buyLot("600519.SH", 125.00, 200); // 25,000 yuan
    expect(lot2.symbol).toBe("600519.SH");

    // 4. In a multi-symbol portfolio without explicit budget, check relative ratio:
    // Existing: 518880.SH (~19,800) + 600519.SH (25,000) = ~44,800.
    // If we try to buy 30,000 of 600519:
    // Target 600519 = 25,000 + 30,000 = 55,000.
    // Total portfolio = 19,800 + 55,000 = 74,800.
    // Ratio = 55,000 / 74,800 = 73.5% > 30% -> Must be blocked!
    const { engine: relativeEngine } = createTestEngine(); // no explicit budget
    relativeEngine.buyLot("518880.SH", 10.00, 2000, undefined, undefined, undefined, true); // 20,000
    relativeEngine.buyLot("510300.SH", 10.00, 2000, undefined, undefined, undefined, true); // 20,000
    relativeEngine.buyLot("588000.SH", 10.00, 2000, undefined, undefined, undefined, true); // 20,000
    // Total portfolio = 60,000 across 3 symbols (20k each = 33.3%).
    // Try to buy 15,000 of 518880:
    // new target = 35,000, new total = 75,000 -> 35k / 75k = 46.7% > 30% -> Blocked!
    expect(() => {
      relativeEngine.buyLot("518880.SH", 10.00, 1500);
    }).toThrow("单标的持仓硬顶风控拦截");
  });

  it("partial close: preserves ACTIVE status, maintains cost basis, and stats multi-attribution", () => {
    const { engine } = createTestEngine();

    // 1. Buy Gold ETF 3000 shares at 6.00
    const lot = engine.buyLot("518880.SH", 6.00, 3000);

    // 2. Partial close 1: Sell 1000 shares at 6.60
    const [updated1, trade1] = engine.closeLot(lot.lot_id, 6.60, 1000);
    expect(updated1.remaining_quantity).toBe(2000);
    expect(updated1.status).toBe(LotStatus.ACTIVE);
    expect(trade1.quantity).toBe(1000);
    expect(trade1.realized_pnl).toBeGreaterThan(500);

    // 3. Partial close 2: Sell 1000 shares at 6.80
    const [updated2, trade2] = engine.closeLot(lot.lot_id, 6.80, 1000);
    expect(updated2.remaining_quantity).toBe(1000);
    expect(updated2.status).toBe(LotStatus.ACTIVE);
    expect(trade2.quantity).toBe(1000);

    // 4. Final close: Sell remaining 1000 shares at 7.00
    const [finalLot, trade3] = engine.closeLot(lot.lot_id, 7.00, 1000);
    expect(finalLot.remaining_quantity).toBe(0);
    expect(finalLot.status).toBe(LotStatus.CLOSED);
    expect(trade3.quantity).toBe(1000);

    // 5. Check multi-dimensional stats attribution
    const stats = engine.computeStats();
    expect(stats.total_trades).toBe(3);
    expect(stats.winning_trades).toBe(3);
    expect(stats.win_rate).toBe(1.0);
    expect(stats.total_realized_pnl).toBeGreaterThan(2000);

    // Attribution by trade type
    expect(stats.by_trade_type.native_t0.total_trades).toBe(3);
    expect(stats.by_trade_type.native_t0.winning_trades).toBe(3);

    // Attribution by symbol
    expect(stats.by_symbol["518880.SH"]).toBeDefined();
    expect(stats.by_symbol["518880.SH"].total_trades).toBe(3);
    expect(stats.by_symbol["518880.SH"].win_rate).toBe(1.0);
  });
});

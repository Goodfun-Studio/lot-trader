import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppDatabase } from "../src/db.ts";
import { TraderEngine } from "../src/engine.ts";
import { Database } from "bun:sqlite";

describe("Cash Dividends Management Tests", () => {
  let db: AppDatabase;
  let conn: Database;
  let engine: TraderEngine;

  beforeEach(() => {
    db = new AppDatabase(":memory:");
    conn = db.getConnection();
    engine = new TraderEngine(conn);
  });

  afterEach(() => {
    db.close();
  });

  it("1. records a cash dividend successfully with full fields", () => {
    const div = engine.addDividend({
      symbol: "600036", // auto normalizes to 600036.SH
      amount: 13240.48,
      exDate: "2026-07-15",
      accountId: "CMB",
      sharesCount: 1300,
      dividendPerShare: 10.185,
      notes: "2025年度分红",
    });

    expect(div.dividend_id).toStartWith("DIV-");
    expect(div.symbol).toBe("600036.SH");
    expect(div.amount).toBe(13240.48);
    expect(div.account_id).toBe("CMB");
    expect(div.ex_date).toBe("2026-07-15");
    expect(div.shares_count).toBe(1300);
    expect(div.notes).toBe("2025年度分红");

    // Query back
    const list = engine.getDividends({ symbol: "600036.SH" });
    expect(list.length).toBe(1);
    expect(list[0].dividend_id).toBe(div.dividend_id);
    expect(list[0].amount).toBe(13240.48);
  });

  it("2. supports multi-account isolation and aggregation", () => {
    engine.addDividend({
      symbol: "601398.SH",
      amount: 309.00,
      accountId: "CMB",
      exDate: "2026-07-10",
    });

    engine.addDividend({
      symbol: "601398.SH",
      amount: 474.90,
      accountId: "PA",
      exDate: "2026-07-12",
    });

    // Check CMB
    const cmbTotal = engine.getTotalDividends("601398.SH", "CMB");
    expect(cmbTotal).toBe(309.00);

    // Check PA
    const paTotal = engine.getTotalDividends("601398.SH", "PA");
    expect(paTotal).toBe(474.90);

    // Check ALL
    const allTotal = engine.getTotalDividends("601398.SH");
    expect(allTotal).toBe(783.90);

    // Filter list
    const cmbList = engine.getDividends({ accountId: "CMB" });
    expect(cmbList.length).toBe(1);
    expect(cmbList[0].amount).toBe(309.00);
  });

  it("3. NEGATIVE GUARD: blocks invalid amount <= 0, NaN, and bad date", () => {
    expect(() => {
      engine.addDividend({
        symbol: "600519.SH",
        amount: 0,
      });
    }).toThrow("Must be a positive finite number");

    expect(() => {
      engine.addDividend({
        symbol: "600519.SH",
        amount: -500,
      });
    }).toThrow("Must be a positive finite number");

    expect(() => {
      engine.addDividend({
        symbol: "600519.SH",
        amount: NaN,
      });
    }).toThrow("Must be a positive finite number");

    expect(() => {
      engine.addDividend({
        symbol: "600519.SH",
        amount: 1000,
        exDate: "2026/07/15", // wrong format
      });
    }).toThrow("Must be YYYY-MM-DD");
  });

  it("4. handles querying non-existent dividends gracefully without throwing", () => {
    const list = engine.getDividends({ symbol: "999999.SZ" });
    expect(list).toBeArray();
    expect(list.length).toBe(0);

    const total = engine.getTotalDividends("999999.SZ");
    expect(total).toBe(0.0);
  });

  it("5. validates CLI trade dividend add and list end-to-end", async () => {
    const div = engine.addDividend({
      symbol: "600585.SH",
      amount: 7857.00,
      exDate: "2026-06-20",
      accountId: "CMB",
      notes: "海螺水泥2025分红",
    });

    const divs = engine.getDividends({ symbol: "600585.SH" });
    expect(divs.length).toBe(1);
    expect(divs[0].amount).toBe(7857.00);

    const total = engine.getTotalDividends("600585.SH");
    expect(total).toBe(7857.00);
  });

});

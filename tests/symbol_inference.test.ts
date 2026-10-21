import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { inferSymbolMetadata } from "../src/quotes.ts";
import { AppDatabase } from "../src/db.ts";
import { SettlementArbitrator } from "../src/settlement.ts";
import { AssetClass, SettlementMode } from "../src/models.ts";
import { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "fs";

describe("Bug 1 & Bug 2: Symbol Inference & DB Path Verification", () => {
  it("Bug 2验收矩阵: 严格前缀与白名单推导", () => {
    // 1. 600513.SH (联环药业) - 必须是 STOCK + STATUTORY_T1，绝不能被 513 误判为 NATIVE_T0
    const m600513 = inferSymbolMetadata("600513.SH");
    expect(m600513.assetClass).toBe(AssetClass.STOCK);
    expect(m600513.settlementMode).toBe(SettlementMode.STATUTORY_T1);

    // 2. 000155.SZ (四川美丰) - 必须是 STOCK + STATUTORY_T1，绝不能被 15 误判为 ETF
    const m000155 = inferSymbolMetadata("000155.SZ");
    expect(m000155.assetClass).toBe(AssetClass.STOCK);
    expect(m000155.settlementMode).toBe(SettlementMode.STATUTORY_T1);

    // 3. 513300.SH (纳指科技ETF) - 必须是 ETF + NATIVE_T0 (跨境 513xxx)
    const m513300 = inferSymbolMetadata("513300.SH");
    expect(m513300.assetClass).toBe(AssetClass.ETF);
    expect(m513300.settlementMode).toBe(SettlementMode.NATIVE_T0);

    // 4. 518880.SH (黄金ETF) - 必须是 ETF + NATIVE_T0 (黄金白名单)
    const m518880 = inferSymbolMetadata("518880.SH");
    expect(m518880.assetClass).toBe(AssetClass.ETF);
    expect(m518880.settlementMode).toBe(SettlementMode.NATIVE_T0);

    // 5. 510300.SH (沪深300ETF) - 必须是 ETF + STATUTORY_T1 (非跨境、非黄金)
    const m510300 = inferSymbolMetadata("510300.SH");
    expect(m510300.assetClass).toBe(AssetClass.ETF);
    expect(m510300.settlementMode).toBe(SettlementMode.STATUTORY_T1);
  });

  it("SettlementArbitrator fallback: 未入库标的严格遵循推导规则", () => {
    const memDb = new AppDatabase(":memory:");
    const conn = memDb.getConnection();
    const arbitrator = new SettlementArbitrator(conn);

    // 600513.SH 未在 symbols 表中，fallback 绝不能返回 NATIVE_T0
    const mode600513 = arbitrator.getSymbolSettlementMode("600513.SH");
    expect(mode600513).toBe(SettlementMode.STATUTORY_T1);

    // 513300.SH 未在 symbols 表中，fallback 必须正确识别为 NATIVE_T0
    const mode513300 = arbitrator.getSymbolSettlementMode("513300.SH");
    expect(mode513300).toBe(SettlementMode.NATIVE_T0);

    memDb.close();
  });

  it("Bug 1验收: TRADE_DB_PATH 环境变量正确生效", () => {
    const testDbPath = "/tmp/test_trade_db_env.db";
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    const prevLotDb = process.env.LOT_TRADER_DB;
    const prevTradeDb = process.env.TRADE_DB_PATH;

    try {
      delete process.env.LOT_TRADER_DB;
      process.env.TRADE_DB_PATH = testDbPath;

      const appDb = new AppDatabase();
      expect(appDb.dbPath).toBe(testDbPath);

      const conn = appDb.getConnection();
      conn.run("SELECT 1;");
      appDb.close();

      expect(existsSync(testDbPath)).toBeTrue();
    } finally {
      if (prevLotDb) process.env.LOT_TRADER_DB = prevLotDb;
      else delete process.env.LOT_TRADER_DB;

      if (prevTradeDb) process.env.TRADE_DB_PATH = prevTradeDb;
      else delete process.env.TRADE_DB_PATH;

      if (existsSync(testDbPath)) {
        unlinkSync(testDbPath);
      }
    }
  });
});

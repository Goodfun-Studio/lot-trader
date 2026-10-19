import { describe, expect, it } from "bun:test";
import { AppDatabase } from "../src/db.ts";

describe("Database Initialization", () => {
  it("initializes tables and seeds default symbols", () => {
    const db = new AppDatabase(":memory:");
    const conn = db.getConnection();

    const tables = conn.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map((r) => r.name);

    expect(tables).toContain("symbols");
    expect(tables).toContain("lots");
    expect(tables).toContain("signals");
    expect(tables).toContain("trades");

    const goldRow = conn.query<any, [string]>(
      "SELECT * FROM symbols WHERE symbol = ?"
    ).get("518880.SH");
    expect(goldRow).not.toBeNull();
    expect(goldRow.settlement_mode).toBe("NATIVE_T0");

    const stockRow = conn.query<any, [string]>(
      "SELECT * FROM symbols WHERE symbol = ?"
    ).get("600519.SH");
    expect(stockRow).not.toBeNull();
    expect(stockRow.settlement_mode).toBe("STATUTORY_T1");

    db.close();
  });
});


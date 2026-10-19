import { describe, expect, it } from "bun:test";
import { QuoteProvider, normalizeSymbol } from "../src/quotes.ts";

describe("Quotes normalization and provider", () => {
  it("normalizes symbols correctly", () => {
    expect(normalizeSymbol("518880")).toEqual(["518880.SH", "sh518880"]);
    expect(normalizeSymbol("600519")).toEqual(["600519.SH", "sh600519"]);
    expect(normalizeSymbol("000001")).toEqual(["000001.SZ", "sz000001"]);
    expect(normalizeSymbol("159934")).toEqual(["159934.SZ", "sz159934"]);
    expect(normalizeSymbol("518880.sh")).toEqual(["518880.SH", "sh518880"]);
  });

  it("handles mock quotes properly", async () => {
    const qp = new QuoteProvider();
    qp.setMockPrice("518880.SH", 8.50);
    const quotes = await qp.getQuotes(["518880.SH"]);
    expect(quotes["518880.SH"]).toBeDefined();
    expect(quotes["518880.SH"].current_price).toBe(8.50);
  });
});


import { AssetClass, SettlementMode } from "./models.ts";
/**
 * Real-time quotes provider with Tencent qt.gtimg.cn and offline mock fallback.
 */

export interface Quote {
  symbol: string;
  name: string;
  current_price: number;
  yesterday_close: number;
  open_price: number;
  high_price: number;
  low_price: number;
  volume: number;
  amount: number;
  time_str: string;
  /** 当日换手率百分比 (单位 %)，例如 0.27 表示 0.27%；腾讯行情第 38 项。缺失/异常时为 undefined */
  turnover_rate?: number;
}

export interface DailyBar {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number; // 手
}


/**
 * Normalizes user input symbol to:
 * [standard_symbol, tencent_symbol]
 * e.g.:
 * "518880" -> ["518880.SH", "sh518880"]
 * "518880.SH" -> ["518880.SH", "sh518880"]
 * "000001" -> ["000001.SZ", "sz000001"]
 * "600519" -> ["600519.SH", "sh600519"]
 */
export function normalizeSymbol(code: string): [string, string] {
  let clean = code.trim();
  const lower = clean.toLowerCase();
  if (lower.startsWith("sh") || lower.startsWith("sz") || lower.startsWith("bj")) {
    const market = clean.slice(0, 2).toUpperCase();
    const numPart = clean.slice(2);
    return [`${numPart}.${market}`, `${market.toLowerCase()}${numPart}`];
  }

  clean = clean.toUpperCase();
  if (clean.includes(".")) {
    const parts = clean.split(".");
    const codePart = parts[0];
    const marketPart = parts[1];
    const std = `${codePart}.${marketPart}`;
    const tc = `${marketPart.toLowerCase()}${codePart}`;
    return [std, tc];
  }

  // Guess market by code prefix
  // SH: 5xxxxx, 6xxxxx, 9xxxxx
  // SZ: 0xxxxx, 1xxxxx, 2xxxxx, 3xxxxx
  // BJ: 4xxxxx, 8xxxxx
  if (clean.startsWith("5") || clean.startsWith("6") || clean.startsWith("9")) {
    return [`${clean}.SH`, `sh${clean}`];
  } else if (
    clean.startsWith("0") ||
    clean.startsWith("1") ||
    clean.startsWith("2") ||
    clean.startsWith("3")
  ) {
    return [`${clean}.SZ`, `sz${clean}`];
  } else if (clean.startsWith("4") || clean.startsWith("8")) {
    return [`${clean}.BJ`, `bj${clean}`];
  } else {
    // Default fallback
    return [`${clean}.SH`, `sh${clean}`];
  }
}

export class QuoteProvider {
  private mockQuotes: Map<string, number> = new Map();
  private mockTurnover: Map<string, number> = new Map();
  private mockBars: Map<string, DailyBar[]> = new Map();

  constructor(mockQuotes?: Record<string, number | { price: number; turnover_rate?: number }>) {
    if (mockQuotes) {
      for (const [k, v] of Object.entries(mockQuotes)) {
        const [std] = normalizeSymbol(k);
        if (typeof v === "number") {
          this.mockQuotes.set(std, v);
        } else if (v && typeof v.price === "number") {
          this.mockQuotes.set(std, v.price);
          if (v.turnover_rate !== undefined) {
            this.setMockTurnover(std, v.turnover_rate);
          }
        }
      }
    }
  }

  public setMockPrice(symbol: string, price: number): void {
    const [std] = normalizeSymbol(symbol);
    this.mockQuotes.set(std, price);
  }

  /** 注入离线 Mock 换手率 (单位 %)，非法值直接忽略，保证下游永不读到 NaN */
  public setMockTurnover(symbol: string, turnoverRate: number): void {
    const [std] = normalizeSymbol(symbol);
    if (typeof turnoverRate !== "number" || !Number.isFinite(turnoverRate) || turnoverRate <= 0) {
      this.mockTurnover.delete(std);
      return;
    }
    this.mockTurnover.set(std, turnoverRate);
  }

  public setMockBars(symbol: string, bars: DailyBar[]): void {
    const [std] = normalizeSymbol(symbol);
    this.mockBars.set(std, bars);
  }

  public async getDailyBars(symbol: string, count: number = 60): Promise<DailyBar[]> {
    const [std, tc] = normalizeSymbol(symbol);
    if (this.mockBars.has(std)) {
      const all = this.mockBars.get(std)!;
      return all.slice(-count);
    }

    // 1. Request Tencent fqkline endpoint
    try {
      const url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=" + tc + ",day,,," + count + ",qfq";
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        const text = await resp.text();
        if (text.startsWith("{")) {
          const json: any = JSON.parse(text);
          if (json && json.code === 0 && json.data && json.data[tc]) {
            const targetData = json.data[tc];
            const rawBars: any[] = targetData.qfqday || targetData.day || [];
            if (Array.isArray(rawBars) && rawBars.length >= 5) {
              const bars: DailyBar[] = [];
              for (const item of rawBars) {
                if (!Array.isArray(item) || item.length < 6) continue;
                const [date, openStr, closeStr, highStr, lowStr, volStr] = item;
                bars.push({
                  date: String(date),
                  open: parseFloat(openStr) || 0,
                  close: parseFloat(closeStr) || 0,
                  high: parseFloat(highStr) || 0,
                  low: parseFloat(lowStr) || 0,
                  volume: parseFloat(volStr) || 0,
                });
              }
              if (bars.length >= 5) {
                return bars.slice(-count);
              }
            }
          }
        }
      }
    } catch {
      // Fall through to Sina fallback
    }

    // 2. Sina KLine fallback
    try {
      const sinaUrl = "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=" + tc + "&scale=240&ma=no&datalen=" + count;
      const resp = await fetch(sinaUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(4000),
      });
      if (resp.ok) {
        const json: any = await resp.json();
        if (Array.isArray(json) && json.length >= 5) {
          const bars: DailyBar[] = [];
          for (const item of json) {
            bars.push({
              date: String(item.day),
              open: parseFloat(item.open) || 0,
              close: parseFloat(item.close) || 0,
              high: parseFloat(item.high) || 0,
              low: parseFloat(item.low) || 0,
              volume: (parseFloat(item.volume) || 0) / 100, // convert shares to 手
            });
          }
          if (bars.length >= 5) {
            return bars.slice(-count);
          }
        }
      }
    } catch {
      // Return empty array
    }

    return [];
  }


  public async getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    const results: Record<string, Quote> = {};
    const neededRemote: Array<[string, string]> = [];

    for (const s of symbols) {
      const [std, tc] = normalizeSymbol(s);
      if (this.mockQuotes.has(std)) {
        const p = this.mockQuotes.get(std)!;
        results[std] = {
          symbol: std,
          name: std,
          current_price: p,
          yesterday_close: p,
          open_price: p,
          high_price: p,
          low_price: p,
          volume: 0,
          amount: 0,
          time_str: "MOCK",
        };
        const mockTau = this.mockTurnover.get(std);
        if (mockTau !== undefined) {
          results[std].turnover_rate = mockTau;
        }
      } else {
        neededRemote.push([std, tc]);
      }
    }

    if (neededRemote.length === 0) {
      return results;
    }

    // Fetch from qt.gtimg.cn
    const tcCodes = neededRemote.map(([_, tc]) => tc).join(",");
    const url = `http://qt.gtimg.cn/q=${tcCodes}`;

    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(3000),
      });

      if (resp.ok) {
        const arrayBuf = await resp.arrayBuffer();
        let textContent = "";
        try {
          const decoder = new TextDecoder("gbk");
          textContent = decoder.decode(arrayBuf);
        } catch {
          const decoder = new TextDecoder("utf-8");
          textContent = decoder.decode(arrayBuf);
        }

        const lines = textContent.trim().split(";");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const match = trimmed.match(/v_([a-zA-Z0-9]+)="([^"]*)"/);
          if (!match) continue;

          const tcCode = match[1].toLowerCase();
          const dataStr = match[2];
          const fields = dataStr.split("~");
          if (fields.length < 10) continue;

          const name = fields[1];
          const currPStr = fields[3];
          const closePStr = fields[4];
          const openPStr = fields[5];
          const volStr = fields[6];
          const highPStr = fields.length > 33 && fields[33] ? fields[33] : currPStr;
          const lowPStr = fields.length > 34 && fields[34] ? fields[34] : currPStr;
          const timeVal = fields.length > 30 ? fields[30] : "";
          // 字段 38 = 当日换手率百分比；缺失或非法 (含字符串 "") 一律视为不可用
          const rawTau = fields.length > 38 ? fields[38] : "";
          const parsedTau = parseFloat(rawTau);
          const turnoverRate =
            Number.isFinite(parsedTau) && parsedTau > 0 ? parsedTau : undefined;

          for (const [std, tc] of neededRemote) {
            if (tc.toLowerCase() === tcCode) {
              const currP = parseFloat(currPStr) || 0;
              results[std] = {
                symbol: std,
                name: name,
                current_price: currP,
                yesterday_close: parseFloat(closePStr) || currP,
                open_price: parseFloat(openPStr) || currP,
                high_price: parseFloat(highPStr) || currP,
                low_price: parseFloat(lowPStr) || currP,
                volume: parseInt(volStr, 10) || 0,
                amount: 0,
                time_str: timeVal,
              };
              if (turnoverRate !== undefined) {
                results[std].turnover_rate = turnoverRate;
              }
              break;
            }
          }
        }
      }
    } catch {
      // Ignore network errors or timeouts; fallback gracefully
    }

    return results;
  }
}



export interface InferredSymbolMetadata {
  cleanCode: string;
  stdSymbol: string;
  tencentCode: string;
  assetClass: AssetClass;
  settlementMode: SettlementMode;
}

/**
 * Strictly infers asset class and settlement mode by 6-digit prefix.
 * Strict rules:
 * - Shanghai ETF: 51xxxx, 52xxxx, 56xxxx, 58xxxx
 * - Shenzhen ETF: 15xxxx, 16xxxx, 18xxxx
 * - All others: STOCK + STATUTORY_T1
 * - Native T+0 whitelist: Gold ETFs (518880, 518800, 159934, 159937) and Cross-border ETFs (513xxx)
 * - All other ETFs: STATUTORY_T1
 */
export function inferSymbolMetadata(code: string): InferredSymbolMetadata {
  const [stdSymbol, tencentCode] = normalizeSymbol(code);
  const cleanCode = stdSymbol.replace(/\.(SH|SZ|BJ)$/i, "");

  // 1. Asset Class via strict 6-digit prefix
  const isShEtf = /^(51|52|56|58)\d{4}$/.test(cleanCode);
  const isSzEtf = /^(15|16|18)\d{4}$/.test(cleanCode);
  const isEtf = isShEtf || isSzEtf;
  const assetClass = isEtf ? AssetClass.ETF : AssetClass.STOCK;

  // 2. Settlement Mode: strictly whitelisted T+0
  const goldWhitelist = ["518880", "518800", "159934", "159937"];
  const isGold = goldWhitelist.includes(cleanCode);
  const isCrossBorderEtf = /^513\d{3}$/.test(cleanCode);

  let settlementMode = SettlementMode.STATUTORY_T1;
  if (isGold || isCrossBorderEtf) {
    settlementMode = SettlementMode.NATIVE_T0;
  }

  return {
    cleanCode,
    stdSymbol,
    tencentCode,
    assetClass,
    settlementMode,
  };
}

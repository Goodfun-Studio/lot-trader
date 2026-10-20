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
  private mockBars: Map<string, DailyBar[]> = new Map();

  constructor(mockQuotes?: Record<string, number>) {
    if (mockQuotes) {
      for (const [k, v] of Object.entries(mockQuotes)) {
        const [std] = normalizeSymbol(k);
        this.mockQuotes.set(std, v);
      }
    }
  }

  public setMockPrice(symbol: string, price: number): void {
    const [std] = normalizeSymbol(symbol);
    this.mockQuotes.set(std, price);
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

    // Request Tencent fqkline endpoint
    const url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=" + tc + ",day,,," + count + ",qfq";
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        return [];
      }
      const json: any = await resp.json();
      if (!json || json.code !== 0 || !json.data || !json.data[tc]) {
        return [];
      }
      const targetData = json.data[tc];
      const rawBars: any[] = targetData.qfqday || targetData.day || [];
      if (!Array.isArray(rawBars)) {
        return [];
      }

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
      return bars.slice(-count);
    } catch {
      return [];
    }
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


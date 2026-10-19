"""Real-time quotes provider with Tencent qt.gtimg.cn and offline mock fallback."""
import re
import urllib.request
from dataclasses import dataclass
from decimal import Decimal
from typing import Dict, List, Optional, Tuple


@dataclass
class Quote:
    symbol: str
    name: str
    current_price: Decimal
    yesterday_close: Decimal
    open_price: Decimal
    high_price: Decimal
    low_price: Decimal
    volume: int
    amount: Decimal
    time_str: str


def normalize_symbol(code: str) -> Tuple[str, str]:
    """
    Normalizes user input symbol to:
    (standard_symbol, tencent_symbol)
    e.g.:
    "518880" -> ("518880.SH", "sh518880")
    "518880.SH" -> ("518880.SH", "sh518880")
    "000001" -> ("000001.SZ", "sz000001")
    "600519" -> ("600519.SH", "sh600519")
    """
    clean = code.strip().upper()
    if "." in clean:
        parts = clean.split(".")
        code_part = parts[0]
        market_part = parts[1]
        std = f"{code_part}.{market_part}"
        tc = f"{market_part.lower()}{code_part}"
        return std, tc

    # Guess market by code prefix
    # SH: 5xxxxx, 6xxxxx, 9xxxxx
    # SZ: 0xxxxx, 1xxxxx, 2xxxxx, 3xxxxx
    # BJ: 4xxxxx, 8xxxxx
    if clean.startswith(("5", "6", "9")):
        return f"{clean}.SH", f"sh{clean}"
    elif clean.startswith(("0", "1", "2", "3")):
        return f"{clean}.SZ", f"sz{clean}"
    elif clean.startswith(("4", "8")):
        return f"{clean}.BJ", f"bj{clean}"
    else:
        # Default fallback
        return f"{clean}.SH", f"sh{clean}"


class QuoteProvider:
    def __init__(self, mock_quotes: Optional[Dict[str, Decimal]] = None):
        """
        :param mock_quotes: dict mapping standard symbol (e.g. '518880.SH') to Decimal price.
        """
        self.mock_quotes: Dict[str, Decimal] = mock_quotes or {}

    def set_mock_price(self, symbol: str, price: Decimal or float or str) -> None:
        std, _ = normalize_symbol(symbol)
        self.mock_quotes[std] = Decimal(str(price))

    def get_quotes(self, symbols: List[str]) -> Dict[str, Quote]:
        """Fetch quotes for given symbols, checking mock first, then Tencent qt.gtimg.cn."""
        results: Dict[str, Quote] = {}
        needed_remote: List[Tuple[str, str]] = []

        for s in symbols:
            std, tc = normalize_symbol(s)
            if std in self.mock_quotes:
                p = self.mock_quotes[std]
                results[std] = Quote(
                    symbol=std,
                    name=std,
                    current_price=p,
                    yesterday_close=p,
                    open_price=p,
                    high_price=p,
                    low_price=p,
                    volume=0,
                    amount=Decimal("0.0"),
                    time_str="MOCK"
                )
            else:
                needed_remote.append((std, tc))

        if not needed_remote:
            return results

        # Fetch from qt.gtimg.cn
        tc_codes = [tc for _, tc in needed_remote]
        url = f"http://qt.gtimg.cn/q={','.join(tc_codes)}"
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
            )
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                raw_bytes = resp.read()
                # qt.gtimg.cn returns GBK
                try:
                    text_content = raw_bytes.decode("gbk")
                except UnicodeDecodeError:
                    text_content = raw_bytes.decode("utf-8", errors="ignore")

                lines = text_content.strip().split(";")
                for line in lines:
                    line = line.strip()
                    if not line:
                        continue
                    # Match v_sh518880="1~黄金ETF~..."
                    m = re.match(r'v_([a-zA-Z0-9]+)="([^"]*)"', line)
                    if not m:
                        continue
                    tc_code = m.group(1).lower()
                    data_str = m.group(2)
                    fields = data_str.split("~")
                    if len(fields) < 10:
                        continue
                    name = fields[1]
                    code_num = fields[2]
                    curr_p_str = fields[3]
                    close_p_str = fields[4]
                    open_p_str = fields[5]
                    vol_str = fields[6]
                    high_p_str = fields[33] if len(fields) > 33 and fields[33] else curr_p_str
                    low_p_str = fields[34] if len(fields) > 34 and fields[34] else curr_p_str
                    time_val = fields[30] if len(fields) > 30 else ""

                    # Match back to standard symbol
                    for std, tc in needed_remote:
                        if tc.lower() == tc_code:
                            curr_p = Decimal(curr_p_str)
                            results[std] = Quote(
                                symbol=std,
                                name=name,
                                current_price=curr_p,
                                yesterday_close=Decimal(close_p_str) if close_p_str else curr_p,
                                open_price=Decimal(open_p_str) if open_p_str else curr_p,
                                high_price=Decimal(high_p_str) if high_p_str else curr_p,
                                low_price=Decimal(low_p_str) if low_p_str else curr_p,
                                volume=int(vol_str) if vol_str.isdigit() else 0,
                                amount=Decimal("0.0"),
                                time_str=time_val
                            )
                            break
        except Exception:
            # If network fails or timeout, leave unpopulated or mock fallback
            pass

        return results


import sqlite3, json, subprocess, os, sys, argparse, html

# Generic fallback account id (mirrors src/accounts.ts). No broker literal is hardcoded here:
# every account is discovered from the ledger / accounts registry at generation time.
DEFAULT_ACCOUNT_ID = "DEFAULT"
ACC_TAG_CLASSES = ["tag-blue", "tag-amber", "tag-purple", "tag-green", "tag-red"]

parser = argparse.ArgumentParser(description="Generate Lot Trader Global Dashboard")
parser.add_argument("--out", "-o", default="lot-trader-global-dashboard.html", help="Output HTML file path (default: lot-trader-global-dashboard.html)")
parser.add_argument("--template", "-t", default=None, help="Template HTML path (default: template_base.html in script directory)")
parser.add_argument("--db", default=None, help="SQLite database path (default: ~/.trade/trade.db)")
parser.add_argument("--token", default=None, help="Session token to embed (default: read the credential file)")
parser.add_argument("--token-file", default=None, help="Session credential file (default: $LOT_TRADER_TOKEN_FILE / ~/.lot-trader/session.token)")
args = parser.parse_args()

script_dir = os.path.dirname(os.path.abspath(__file__))
template_path = args.template if args.template else os.path.join(script_dir, "template_base.html")
db_path = args.db if args.db else os.environ.get("TRADE_DB_PATH", os.path.expanduser("~/.trade/trade.db"))

DEFAULT_TOKEN_FILE = os.path.expanduser("~/.lot-trader/session.token")


def resolve_session_token(explicit_token, token_file):
    """Read the same 0600 credential `trade serve` publishes.

    Returns (token, source, path). An absent/unreadable/empty file means "no active
    credential": the page must then run in pure standalone mode rather than guess.
    """
    if explicit_token is not None and str(explicit_token).strip():
        return str(explicit_token).strip(), "explicit", token_file
    path = (token_file or os.environ.get("LOT_TRADER_TOKEN_FILE") or DEFAULT_TOKEN_FILE)
    path = os.path.expanduser(str(path))
    try:
        with open(path, "r", encoding="utf-8") as fh:
            value = fh.read().strip()
    except OSError:
        return "", None, path
    return (value, "credential_file", path) if value else ("", None, path)


session_token, session_token_source, session_token_path = resolve_session_token(
    args.token, args.token_file
)
if session_token:
    print(f"Local session credential loaded from {session_token_path} (mode 0600) — will be injected into the page.")
else:
    print(f"No active local session credential at {session_token_path} — dashboard will open in standalone mode.")

# 1. Fetch live active lots from trade CLI
out_lots = subprocess.check_output(["trade", "lot", "list", "--status", "ACTIVE", "--json"])
lots_active_data = json.loads(out_lots.decode("utf-8"))["data"]

# 2. Fetch stats from trade CLI
out_stats = subprocess.check_output(["trade", "stats", "--json"])
stats_data = json.loads(out_stats.decode("utf-8"))["data"]

# 2.5 Fetch positions with physics momentum radar
print("Fetching position data with physics radar from trade CLI...")
out_pos = subprocess.check_output(["trade", "position", "--json"])
pos_data = json.loads(out_pos.decode("utf-8"))["data"]
physics_by_sym = {t["symbol"]: t.get("physics") for t in pos_data.get("targets", [])}
print(f"Physics data loaded for {len(physics_by_sym)} symbols.")

# Current prices map
curr_prices = {l["symbol"]: l["current_price"] for l in lots_active_data}

# 3. Connect to DB
conn = sqlite3.connect(db_path)
c = conn.cursor()

# Account registry (the `accounts` table is created by the CLI; tolerate pre-migration ledgers).
try:
    c.execute("SELECT account_id, name, broker_code, currency, is_active FROM accounts ORDER BY account_id")
    account_rows = c.fetchall()
except sqlite3.Error:
    account_rows = []

ACCOUNT_LABELS = {}
REGISTERED_ACCOUNTS = []
for _acc_id, _acc_name, _acc_broker, _acc_ccy, _acc_active in account_rows:
    if not _acc_id:
        continue
    ACCOUNT_LABELS[_acc_id] = (_acc_name or _acc_id).strip() or _acc_id
    if _acc_active:
        REGISTERED_ACCOUNTS.append(_acc_id)

# Get all symbols
c.execute("SELECT symbol, name, asset_class, settlement_mode FROM symbols ORDER BY symbol")
symbols_raw = c.fetchall()
symbols_map = {r[0]: {"symbol": r[0], "name": r[1], "asset_class": r[2], "settlement_mode": r[3]} for r in symbols_raw}

# Get all lots (ACTIVE and CLOSED)
c.execute("""
SELECT l.lot_id, l.symbol, s.name, s.asset_class, l.buy_time, l.buy_price, 
       l.buy_quantity, l.remaining_quantity, l.cost_basis_unit, l.status,
       l.close_time, l.close_avg_price, l.realized_pnl, l.account_id,
       l.buy_reason, l.close_reason
FROM lots l
JOIN symbols s ON l.symbol = s.symbol
ORDER BY l.buy_time DESC
""")
all_db_lots = c.fetchall()

# Get all sell trades
c.execute("""
SELECT t.trade_id, s.name, s.symbol, l.buy_time, l.buy_price, t.executed_at, t.price, t.quantity, t.realized_pnl, t.action, t.account_id, t.reason
FROM trades t
JOIN lots l ON t.lot_id = l.lot_id
JOIN symbols s ON l.symbol = s.symbol
WHERE t.action LIKE "SELL%"
ORDER BY t.executed_at DESC
""")
closed_trades_raw = c.fetchall()

# Dividends map by symbol and account.
# Single source of truth: the `dividends` table, read through `trade dividend list --json`.
# The CLI resolves its DB via $LOT_TRADER_DB / $TRADE_DB_PATH, so pin it to this script's db_path.
_div_env = dict(os.environ)
_div_env["LOT_TRADER_DB"] = db_path
try:
    _out_div = subprocess.check_output(["trade", "dividend", "list", "--json"], env=_div_env)
    _div_records = json.loads(_out_div.decode("utf-8"))["data"]["dividends"]
except Exception as _e:
    print(f"Warning: could not load dividends from trade CLI ({_e}); continuing with zero dividends.")
    _div_records = []

DIVIDENDS_BY_SYM_AND_ACC = {}
for _d in _div_records:
    DIVIDENDS_BY_SYM_AND_ACC.setdefault(_d["symbol"], {}).setdefault(_d["account_id"], 0.0)
    DIVIDENDS_BY_SYM_AND_ACC[_d["symbol"]][_d["account_id"]] += float(_d["amount"])
print(f"Dividends loaded from table: {len(_div_records)} records, {sum(sum(v.values()) for v in DIVIDENDS_BY_SYM_AND_ACC.values()):.2f} CNY")

DIVIDENDS_MAP = {sym: sum(v.values()) for sym, v in DIVIDENDS_BY_SYM_AND_ACC.items()}

# Group active lots by symbol (generic per-account buckets)
def acct_of(value):
    """Normalize an account id read from the ledger; blank -> generic fallback."""
    v = (value or "").strip() if isinstance(value, str) else (value or "")
    return v or DEFAULT_ACCOUNT_ID

# Discover every account that actually appears in the books, then union with the registry.
_data_accounts = []
for _l in lots_active_data:
    _a = acct_of(_l.get("account_id"))
    if _a not in _data_accounts:
        _data_accounts.append(_a)
for _t in closed_trades_raw:
    _a = acct_of(_t[10])
    if _a not in _data_accounts:
        _data_accounts.append(_a)
for _sym_acc in DIVIDENDS_BY_SYM_AND_ACC.values():
    for _a in _sym_acc.keys():
        if _a not in _data_accounts:
            _data_accounts.append(_a)

REAL_ACCOUNTS = []
for _a in REGISTERED_ACCOUNTS + _data_accounts:
    if _a in REAL_ACCOUNTS:
        continue
    # The generic fallback only earns a tab when it actually holds ledger rows.
    if _a == DEFAULT_ACCOUNT_ID and _a not in _data_accounts:
        continue
    REAL_ACCOUNTS.append(_a)
ACCOUNT_KEYS = ["ALL"] + REAL_ACCOUNTS

for _a in REAL_ACCOUNTS:
    ACCOUNT_LABELS.setdefault(_a, _a)


def acc_tag_class(acc):
    if acc in ("ALL", "BOTH"):
        return "tag-purple"
    try:
        idx = REAL_ACCOUNTS.index(acc)
    except ValueError:
        idx = 0
    return ACC_TAG_CLASSES[idx % len(ACC_TAG_CLASSES)]


def account_label(acc):
    if acc == "ALL":
        return "全账户合并"
    label = ACCOUNT_LABELS.get(acc, acc)
    return f"{label} ({acc})" if label != acc else acc


def account_short_label(acc):
    if acc == "ALL":
        return "全账户"
    return ACCOUNT_LABELS.get(acc, acc)


def acc_badge_html(acc_mode, compact=False):
    cls = acc_tag_class(acc_mode)
    if acc_mode in ("ALL", "BOTH"):
        text = "全账户" if compact else f"{len(REAL_ACCOUNTS)} 账户合并"
    elif compact:
        text = acc_mode
    else:
        text = account_label(acc_mode)
    return f'<span class="tag {cls}" style="font-size:10px;padding:1px 6px;">{html.escape(text)}</span>'


active_lots_by_sym = {}
for l in lots_active_data:
    sym = l["symbol"]
    if sym not in active_lots_by_sym:
        active_lots_by_sym[sym] = {k: [] for k in ACCOUNT_KEYS}
    active_lots_by_sym[sym]["ALL"].append(l)
    acc = acct_of(l.get("account_id"))
    active_lots_by_sym[sym].setdefault(acc, []).append(l)

# Group all lots by symbol for modal & detail
all_lots_by_sym = {}
for r in all_db_lots:
    lid, sym, name, aclass, btime, bp, bqty, rqty, cbu, status, ctime, cp, rpnl, acc_id, l_buy_reason, l_close_reason = r
    if sym not in all_lots_by_sym:
        all_lots_by_sym[sym] = []
    
    curr_p = curr_prices.get(sym, bp)
    price_now_or_close = cp if status == 'CLOSED' else curr_p
    
    # Lot PnL & return rate
    if status == 'CLOSED':
        lot_pnl = rpnl if rpnl is not None else 0.0
        if cp is not None:
            close_price = cp
        elif bqty > 0 and lot_pnl != 0:
            close_price = bp + (lot_pnl / bqty)
        else:
            close_price = bp
        price_now_or_close = close_price
        lot_rr = (close_price - bp) / bp if bp > 0 else 0
        if lot_pnl < 0:
            lot_tag = '<span class="tag tag-red">微损止损</span>'
        elif lot_rr >= 0.10:
            lot_tag = '<span class="tag tag-green">大幅止盈</span>'
        elif lot_rr >= 0.04:
            lot_tag = '<span class="tag tag-green">波段止盈落袋</span>'
        else:
            lot_tag = '<span class="tag tag-blue">底仓代冲做T</span>'
    else:
        lot_pnl = rqty * (curr_p - cbu)
        lot_rr = (curr_p - cbu) / cbu if cbu > 0 else 0
        if lot_rr > 0.15:
            lot_tag = '<span class="tag tag-green">[跟踪止盈]</span>'
        elif lot_rr > 0.0:
            lot_tag = '<span class="tag tag-green">[持仓观察]</span>'
        elif lot_rr > -0.10:
            lot_tag = '<span class="tag tag-blue">[微亏防守]</span>'
        elif lot_rr > -0.20:
            lot_tag = '<span class="tag tag-amber">[待加仓/观察]</span>'
        elif lot_rr > -0.50:
            lot_tag = '<span class="tag tag-blue">[深跌击球]</span>'
        else:
            lot_tag = '<span class="tag tag-purple">[山顶代冲消融]</span>'

    all_lots_by_sym[sym].append({
        "lot_id": lid,
        "account_id": acct_of(acc_id),
        "cost_unit": cbu,
        "buy_reason": (l_buy_reason or "").strip(),
        "close_reason": (l_close_reason or "").strip(),
        "buy_time": btime.replace('T', ' ')[:16],
        "buy_price": bp,
        "qty": rqty if status == 'ACTIVE' else bqty,
        "status": status,
        "price_now_or_close": price_now_or_close,
        "close_time": ctime.replace('T', ' ')[:16] if ctime else None,
        "pnl": lot_pnl,
        "return_rate": lot_rr,
        "tag": lot_tag
    })

def compute_sym_metrics(sym, lots_list, trades_list, div_val):
    sinfo = symbols_map[sym]
    name = sinfo["name"]
    aclass = sinfo["asset_class"]
    unit = "份" if "ETF" in name or "LOF" in name else "股"
    
    if lots_list:
        shares = sum(l["remaining_quantity"] for l in lots_list)
        cost_total = sum(l["remaining_quantity"] * l["cost_basis_unit"] for l in lots_list)
        cost_unit = cost_total / shares if shares > 0 else 0
        cp = curr_prices.get(sym, cost_unit)
        mkt_val = shares * cp
        float_pnl = sum(l["floating_pnl"] for l in lots_list)
        ret_rate = float_pnl / cost_total if cost_total > 0 else 0
    else:
        shares = 0
        cost_total = 0
        cost_unit = 0
        cp = curr_prices.get(sym, 0)
        mkt_val = 0
        float_pnl = 0
        ret_rate = 0
        
    total_trades = len(trades_list)
    win_trades = sum(1 for t in trades_list if t[8] > 0)
    loss_trades = sum(1 for t in trades_list if t[8] < 0)
    win_pnl = sum(t[8] for t in trades_list if t[8] > 0)
    loss_pnl = sum(abs(t[8]) for t in trades_list if t[8] < 0)
    net_t_pnl = win_pnl - loss_pnl
    win_rate = win_trades / total_trades if total_trades > 0 else 0
    
    if total_trades == 0:
        pf_str = "--"
        pf_val = 0
        avg_rr_str = "--"
    elif loss_trades == 0:
        pf_str = "全胜"
        pf_val = 999
        avg_rr_str = "全胜"
    else:
        pf = win_pnl / loss_pnl if loss_pnl > 0 else 999
        pf_val = pf
        pf_str = f"{pf:.2f}"
        avg_w = win_pnl / win_trades if win_trades > 0 else 0
        avg_l = loss_pnl / loss_trades if loss_trades > 0 else 0
        avg_rr = avg_w / avg_l if avg_l > 0 else 999
        avg_rr_str = f"{avg_rr:.2f}"
        
    total_withdrawn = net_t_pnl + div_val
    
    return {
        "symbol": sym,
        "name": name,
        "asset_class": aclass,
        "qty_unit": unit,
        "shares": shares,
        "cost_unit": cost_unit,
        "current_price": cp,
        "market_value": mkt_val,
        "floating_pnl": float_pnl,
        "return_rate": ret_rate,
        "active_lots_count": len(lots_list),
        "total_trades": total_trades,
        "win_trades": win_trades,
        "loss_trades": loss_trades,
        "win_rate": win_rate,
        "win_pnl": win_pnl,
        "loss_pnl": loss_pnl,
        "net_t_pnl": net_t_pnl,
        "profit_factor": pf_val,
        "profit_factor_str": pf_str,
        "avg_win_loss_str": avg_rr_str,
        "dividends": div_val,
        "total_withdrawn": total_withdrawn,
    }

# Compute target_metrics for the merged view + every discovered account
target_metrics = {k: {} for k in ACCOUNT_KEYS}

for sym, sinfo in symbols_map.items():
    sym_lots_group = active_lots_by_sym.get(sym, {k: [] for k in ACCOUNT_KEYS})
    sym_trades_all = [t for t in closed_trades_raw if t[2] == sym]
    div_dict = DIVIDENDS_BY_SYM_AND_ACC.get(sym, {})

    target_metrics["ALL"][sym] = compute_sym_metrics(
        sym, sym_lots_group.get("ALL", []), sym_trades_all, sum(div_dict.values())
    )

    for acc in REAL_ACCOUNTS:
        acc_lots = sym_lots_group.get(acc, [])
        acc_trades = [t for t in sym_trades_all if acct_of(t[10]) == acc]
        acc_div = div_dict.get(acc, 0.0)
        if acc_lots or acc_trades or acc_div > 0:
            target_metrics[acc][sym] = compute_sym_metrics(sym, acc_lots, acc_trades, acc_div)

target_metrics_all = target_metrics["ALL"]

# Strategy classification for every known symbol.
# NOTE: this table is *classification only* (category / strategy tag / card border).
# It deliberately carries NO numbers and NO narrative: every share count, P&L, return
# rate, T-trade record and dividend figure is derived from the ledger at generation
# time by `build_strategy_note()`. A stale literal here would silently leak an old
# number into the rendered HTML, so the rule is: methodology yes, numbers never.
SYMBOL_NOTES = {
    '513300.SH': ('全球核心成长 • 美股科技慢牛', '[跟踪止盈]', 'rgba(16, 185, 129, 0.4)'),
    '513500.SH': ('全球核心宽基 • 美股全收益基石', '[跟踪止盈]', 'rgba(16, 185, 129, 0.4)'),
    '518880.SH': ('避险硬资产 • 央行去美元化底仓', '[跟踪止盈]', 'rgba(16, 185, 129, 0.4)'),
    '513880.SH': ('全球发达市场 • 亚太出口龙头', '[跟踪止盈]', 'rgba(16, 185, 129, 0.4)'),
    '513080.SH': ('欧洲跨国巨头 • 奢侈品及工业航母', '[跟踪止盈]', 'rgba(16, 185, 129, 0.4)'),
    '513030.SH': ('欧洲高端制造 • 德国工业脊梁', '[跟踪止盈]', 'rgba(16, 185, 129, 0.4)'),
    '164824.SZ': ('新兴市场敞口 • 人口红利消费', '[待加仓/观察]', 'rgba(245, 158, 11, 0.4)'),
    '513330.SH': ('港股科技龙头 • 深度挤估值磨底', '[代冲消融山顶]', 'rgba(139, 92, 246, 0.4)'),
    '600900.SH': ('水电现金牛 • 绝对防守压舱石', '[跟踪止盈]', 'rgba(16, 185, 129, 0.4)'),
    '600036.SH': ('零售银行之王 • 高股息分红先锋', '[底仓做T]', 'rgba(16, 185, 129, 0.4)'),
    '601398.SH': ('国有特大行 • 稳健底仓避风港', '[跟踪止盈]', 'rgba(16, 185, 129, 0.4)'),
    '002233.SZ': ('高股息水泥板块', '[底仓做T]', 'rgba(16, 185, 129, 0.4)'),
    '600276.SH': ('创新药旗舰', '[代冲消融山顶]', 'rgba(59, 130, 246, 0.4)'),
    '600585.SH': ('水泥行业龙头', '[分红现金牛]', 'rgba(59, 130, 246, 0.4)'),
    '300357.SZ': ('脱敏诊疗龙头', '[代冲消融山顶]', 'rgba(139, 92, 246, 0.4)'),
    '002507.SZ': ('大众消费龙头', '[底仓做T]', 'rgba(59, 130, 246, 0.4)'),
    '603260.SH': ('工业硅龙头', '[代冲消融山顶]', 'rgba(239, 68, 68, 0.4)'),
    '002191.SZ': ('烟标与新材料', '[代冲消融山顶]', 'rgba(139, 92, 246, 0.4)'),
    '300595.SZ': ('眼科医疗龙头', '[代冲消融山顶]', 'rgba(6, 182, 212, 0.4)'),
    '601012.SH': ('光伏单晶硅龙头 • 周期底部磨底', '[代冲消融山顶]', 'rgba(34, 197, 94, 0.4)'),
    '300529.SZ': ('血液灌流龙头', '[代冲消融山顶]', 'rgba(236, 72, 153, 0.4)'),
    '002310.SZ': ('综合工业龙头', '[高频做T防守]', 'rgba(249, 115, 22, 0.4)'),
    '600390.SH': ('央企多元金融', '[极小残仓静置]', 'rgba(148, 163, 184, 0.4)'),
    '000877.SZ': ('西北水泥龙头', '[代冲消融山顶]', 'rgba(14, 165, 233, 0.4)'),
    '300601.SZ': ('创新疫苗龙头 • 周期筑底静置', '[代冲消融山顶]', 'rgba(239, 68, 68, 0.4)'),
    '000632.SZ': ('低价重组标的', '[微仓波段防守]', 'rgba(245, 158, 11, 0.4)'),
    '600586.SH': ('超白玻璃龙头', '[底仓代冲做T]', 'rgba(16, 185, 129, 0.4)'),
    '002466.SZ': ('全球锂矿壁垒 • 周期底部持仓观察', '[周期底部观察]', 'rgba(59, 130, 246, 0.4)'),
    '002393.SZ': ('特色制药龙头', '[微仓波段防守]', 'rgba(168, 85, 247, 0.4)'),
    '002603.SZ': ('现代中药龙头', '[底仓代冲做T]', 'rgba(16, 185, 129, 0.4)'),
    '000100.SZ': ('半导体显示龙头', '[底仓代冲做T]', 'rgba(59, 130, 246, 0.4)'),
    '300677.SZ': ('医疗手套龙头', '[底仓代冲做T]', 'rgba(16, 185, 129, 0.4)'),
    '002029.SZ': ('男装品牌消费', '[微仓观察]', 'rgba(245, 158, 11, 0.4)'),
    '600326.SH': ('基建与民爆龙头', '[极小残仓静置]', 'rgba(148, 163, 184, 0.4)'),
    '603678.SH': ('军工电子龙头', '[跟踪止盈]', 'rgba(16, 185, 129, 0.4)'),
    '000725.SZ': ('面板双雄之一', '[持仓观察]', 'rgba(16, 185, 129, 0.4)'),
    '000792.SZ': ('钾肥锂资源龙头 • 周期回升底仓', '[持仓观察]', 'rgba(59, 130, 246, 0.4)'),
    '002856.SZ': ('ST 重组概念 • 游资高弹性脉冲', '[高位止盈]', 'rgba(239, 68, 68, 0.4)'),
    '002883.SZ': ('ST 基础设施工程 • 浅套观察', '[微仓观察]', 'rgba(245, 158, 11, 0.4)'),
    '002719.SZ': ('ST 食品乳业 • 风险警示震荡', '[死水静置]', 'rgba(239, 68, 68, 0.4)'),
    '002193.SZ': ('ST 纺织服装 • 阴跌出清区', '[死水静置]', 'rgba(239, 68, 68, 0.4)'),
    '600822.SH': ('商业贸易与旧物资 • 历史老仓', '[微仓观察]', 'rgba(245, 158, 11, 0.4)'),
    '000623.SZ': ('医药健康与广发证券大股东', '[持仓观察]', 'rgba(59, 130, 246, 0.4)'),
    '600064.SH': ('区域园区综合开发 • 红利收息', '[红利底仓]', 'rgba(59, 130, 246, 0.4)'),
    '000001.SZ': ('全国股份制零售银行 • 稳健分红', '[红利底仓]', 'rgba(16, 185, 129, 0.4)'),
    '600000.SH': ('全国股份制商业银行 • 破净修复', '[红利底仓]', 'rgba(16, 185, 129, 0.4)'),
    '300538.SZ': ('新材料工程塑料 • 残仓底仓观察', '[微仓观察]', 'rgba(245, 158, 11, 0.4)'),
}

DEFAULT_SYMBOL_NOTE = ('A 股赛道标的', '[持仓观察]', 'rgba(59, 130, 246, 0.4)')

# Methodology guidance per strategy tag. Deliberately numeric-free: the concrete figures
# are always appended from the live ledger by `build_strategy_note()`.
STRATEGY_GUIDANCE = {
    '[跟踪止盈]': '深厚利润垫下长期跟踪止盈，享受复利，不追高、不恐慌割肉。',
    '[底仓做T]': '依托昨日及以前可用底仓做 T 锁定波段差价，不新增任何外部资金。',
    '[底仓代冲做T]': '依托底仓急跌反弹做 T，定向冲销历史建仓成本，不扩大敞口。',
    '[代冲消融山顶]': '严禁外部新钱左侧补仓，仅依托底仓急跌反弹做 T，逐步消融历史山顶成本。',
    '[高频做T防守]': '依托底仓脉冲做 T 摊薄成本，严守仓位上限，绝不追加外部资金。',
    '[分红现金牛]': '依托高分红现金流持续回笼现金，逢急跌做 T，不追高。',
    '[红利底仓]': '高股息防守底仓，持有收息，跌深再评估，不做无差别补仓。',
    '[持仓观察]': '维持现有仓位观察，等待信号与年报口径确认后再动。',
    '[待加仓/观察]': '严禁盲目左侧接飞刀，待宏观/行业信号企稳再考虑置换。',
    '[周期底部观察]': '周期底部保留底仓观察，等待供需反转信号，左侧不追加新钱。',
    '[高位止盈]': '高位挂条件单分批止盈，锁定利润，不因单日脉冲继续加仓。',
    '[微仓观察]': '仓位极小，对组合无实质影响，静置观察等待右侧脉冲。',
    '[微仓波段防守]': '微仓防守，严格焊死仓位上限，不做无依据摊薄。',
    '[极小残仓静置]': '极小残仓静置，避免频繁交易抬升摩擦成本。',
    '[死水静置]': '无量阴跌标的静置不动，坚决不进新钱，等待题材脉冲。',
}
DEFAULT_STRATEGY_GUIDANCE = '严格执行批次独立核算，依托底仓做 T，严禁盲目左侧补仓。'


def build_strategy_note(m, strat_tag):
    """Derive a per-symbol strategy narrative from the *live ledger metrics*.

    Zero hardcoded numbers: shares / P&L / return rate / T record / dividends / withdrawn
    cash all come from the same `compute_sym_metrics` row that feeds every other panel.
    """
    shares = m.get('shares', 0) or 0
    unit = m.get('qty_unit', '份')
    mkt = m.get('market_value', 0) or 0
    pnl = m.get('floating_pnl', 0) or 0
    rr = m.get('return_rate', 0) or 0

    parts = []
    if shares > 0:
        parts.append(
            f"在场 {shares:,.0f} {unit}，市值 ¥{mkt:,.0f}，"
            f"浮动盈亏 {'+' if pnl > 0 else ('-' if pnl < 0 else '')}¥{abs(pnl):,.0f}"
            f"（{'+' if rr > 0 else ''}{rr * 100:.1f}%）"
        )
    else:
        parts.append("当前无在场持仓")

    trades = m.get('total_trades', 0) or 0
    if trades > 0:
        net = m.get('net_t_pnl', 0) or 0
        parts.append(
            f"历史做 T {trades} 战 {m.get('win_trades', 0)} 胜"
            f"（净 {'+' if net >= 0 else '-'}¥{abs(net):,.0f}）"
        )

    dividends = m.get('dividends', 0) or 0
    if dividends:
        parts.append(f"累计分红 +¥{dividends:,.0f}")

    withdrawn = m.get('total_withdrawn', 0) or 0
    if withdrawn:
        parts.append(f"累计回笼现金 {'+' if withdrawn >= 0 else '-'}¥{abs(withdrawn):,.0f}")

    return "；".join(parts) + "。" + STRATEGY_GUIDANCE.get(strat_tag, DEFAULT_STRATEGY_GUIDANCE)


def format_physics_badge_card(p):
    if not p:
        return '<span class="tag tag-blue" style="font-size:10px;">--</span>'
    st = p.get("brake_status", "STEADY")
    m = p.get("m", 1.0)
    conf = p.get("confidence_level", "MEDIUM")
    if st == "STEADY":
        return '<span class="tag tag-blue" style="font-size:10px;padding:2px 6px;">⚖️ STEADY 匀速稳态</span>'
    elif st == "ACCELERATING_UP":
        if conf == "LOW":
            return '<span class="tag tag-amber" style="font-size:10px;padding:2px 6px;">🚀 ACCEL_UP (无量虚火)</span>'
        elif conf == "HIGH":
            return '<span class="tag tag-green" style="font-size:10px;padding:2px 6px;">🚀 ACCEL_UP (放量变盘)</span>'
        elif m < 0.7:
            return '<span class="tag tag-green" style="font-size:10px;padding:2px 6px;">🚀 ACCEL_UP (缩量)</span>'
        return '<span class="tag tag-green" style="font-size:10px;padding:2px 6px;">🚀 ACCEL_UP 加速反弹</span>'
    elif st == "ACCELERATING_DOWN":
        if conf == "HIGH":
            return '<span class="tag tag-red" style="font-size:10px;padding:2px 6px;">⚠️ ACCEL_DOWN (放量砸盘)</span>'
        return '<span class="tag tag-red" style="font-size:10px;padding:2px 6px;">⚠️ ACCEL_DOWN 失速下坠</span>'
    elif st == "BRAKING_BOTTOM":
        return '<span class="tag tag-amber" style="font-size:10px;padding:2px 6px;">🛑 BRAKE_BOTTOM 底部刹车</span>'
    elif st == "BRAKING_TOP":
        return '<span class="tag tag-purple" style="font-size:10px;padding:2px 6px;">🛑 BRAKE_TOP 顶部减速</span>'
    return f'<span class="tag tag-blue" style="font-size:10px;">{st}</span>'

def format_physics_badge_table(p):
    if not p:
        return '<span class="tag tag-blue" style="font-size:10px;">--</span>'
    st = p.get("brake_status", "STEADY")
    m = p.get("m", 1.0)
    if st == "STEADY":
        return '<span class="tag tag-blue" style="font-size:10px;">稳态</span>'
    elif st == "ACCELERATING_UP":
        if m < 0.7:
            return '<span class="tag tag-green" style="font-size:10px;">反弹(缩量)</span>'
        return '<span class="tag tag-green" style="font-size:10px;">加速反弹</span>'
    elif st == "ACCELERATING_DOWN":
        return '<span class="tag tag-red" style="font-size:10px;">失速下坠</span>'
    elif st == "BRAKING_BOTTOM":
        return '<span class="tag tag-amber" style="font-size:10px;">底部刹车</span>'
    elif st == "BRAKING_TOP":
        return '<span class="tag tag-purple" style="font-size:10px;">顶部减速</span>'
    return f'<span class="tag tag-blue" style="font-size:10px;">{st}</span>'

# Symbols with active shares
active_syms_list = [s for s in symbols_map.keys() if active_lots_by_sym.get(s, {}).get("ALL")]

# Build Target Cards HTML
sorted_syms_by_mkt = sorted(
    active_syms_list,
    key=lambda s: target_metrics_all[s]["market_value"],
    reverse=True
)

target_cards_html = []
target_js_data = {}

def _num(x, default=0.0):
    """Coerce a physics metric into a finite float for data-* sort attributes."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return v if v == v and abs(v) != float('inf') else default

def build_single_card(sym, m, acc_mode, visibility, is_hidden=False):
    cat_tag, strat_tag, border_col = SYMBOL_NOTES.get(sym, DEFAULT_SYMBOL_NOTE)
    strat_desc = build_strategy_note(m, strat_tag)

    qty_str = f"{m['shares']:,} {m['qty_unit']}"
    cost_str = f"¥{m['cost_unit']:.3f}" if m['cost_unit'] < 2.0 else f"¥{m['cost_unit']:.2f}"
    curr_p_str = f"¥{m['current_price']:.3f}" if m['current_price'] < 2.0 else f"¥{m['current_price']:.2f}"
    mkt_val_str = f"¥{m['market_value']:,.0f}"

    fpnl = m['floating_pnl']
    fpnl_class = "val-green" if fpnl >= 0 else "val-red"
    fpnl_str = f"-¥{abs(fpnl):,.0f}" if fpnl < 0 else (f"+¥{fpnl:,.0f}" if fpnl > 0 else "¥0")

    rr = m['return_rate']
    rr_class = "val-green" if rr >= 0 else "val-red"
    rr_str = f"-{abs(rr)*100:.2f}%" if rr < 0 else (f"+{rr*100:.2f}%" if rr > 0 else "0.00%")

    if m['total_trades'] > 0:
        win_class = "val-green" if m['net_t_pnl'] >= 0 else "val-red"
        t_stats_str = f"{m['win_trades']}胜{m['loss_trades']}负 ({'+' if m['net_t_pnl'] >= 0 else ''}¥{m['net_t_pnl']:,.0f})"
    else:
        win_class = ""
        t_stats_str = "无平仓记录"

    pf_str = m['profit_factor_str']
    if pf_str == '全胜':
        pf_class = "val-green"
    elif pf_str == '--':
        pf_class = ""
    elif m['profit_factor'] >= 1.5:
        pf_class = "val-green"
    elif m['profit_factor'] < 1.0:
        pf_class = "val-red"
    else:
        pf_class = "val-blue"

    tot_cost = m['cost_unit'] * m['shares']
    mult_val = (m['market_value'] / tot_cost) if tot_cost > 0 else 1.0
    mult_class = "val-green" if mult_val >= 1.0 else "val-red"
    mult_str = f"{mult_val:.2f}x"

    p = physics_by_sym.get(sym) or {}
    brake_status = p.get("brake_status", "STEADY")
    p_rank60 = p.get("pct_rank_60", 50.0)
    p_rank250 = p.get("pct_rank_250", 50.0)
    v_val = p.get("v_short", 0.0)
    m_val = p.get("m", 1.0)
    f_val = p.get("F", 0.0)

    fill_cls_60 = "fill-green" if p_rank60 <= 20 else ("fill-red" if p_rank60 >= 80 else "fill-blue")
    fill_cls_250 = "fill-green" if p_rank250 <= 20 else ("fill-purple" if p_rank250 >= 80 else "fill-blue")

    v_cls = "val-green" if v_val > 0 else ("val-red" if v_val < 0 else "")
    v_str = f"{'+' if v_val > 0 else ''}{v_val:.2f}%"
    m_cls = "val-green" if m_val >= 1.2 else ("val-amber" if m_val < 0.7 else "")
    m_str = f"{m_val:.2f}x"

    feff_val = p.get("effective_force", f_val)
    conf_lvl = p.get("confidence_level", "MEDIUM")
    feff_cls = "val-green" if feff_val > 0 else ("val-red" if feff_val < 0 else "")
    feff_str = f"{'+' if feff_val > 0 else ''}{feff_val:.2f}"
    conf_col = "#10b981" if conf_lvl == "HIGH" else ("#f59e0b" if conf_lvl == "LOW" else "#38bdf8")
    conf_badge = f'<span style="font-size:9px;color:{conf_col};font-weight:600;">[{conf_lvl}]</span>'

    # Numeric values for physics-based card sorting (data-* attributes)
    feff_num = _num(feff_val)
    f_num = _num(f_val)
    v_num = _num(v_val)

    card_badge_html = format_physics_badge_card(p)

    acc_badge = acc_badge_html(acc_mode)

    display_style = 'display:none;' if is_hidden else ''
    total_lots_count = m['active_lots_count']

    return f"""          <!-- Target Card: {m['name']} ({sym}) [{acc_mode}] -->
          <div class="target-card" onclick="openTargetModal('{sym}')" data-sym="{sym}" data-account-visibility="{visibility}" data-account="{acc_mode}" data-brake-status="{brake_status}" data-qty="{m['shares']}" data-cost-val="{m['cost_unit'] * m['shares']:.2f}" data-rank-250="{p_rank250:.2f}" data-force-eff="{feff_num:.4f}" data-force-raw="{f_num:.4f}" data-v-short="{v_num:.4f}" data-pnl-rate="{m['return_rate']:.6f}" data-mkt-val="{m['market_value']:.2f}" style="border-color: {border_col}; {display_style}">
            <div class="target-card-head">
              <div>
                <div class="target-card-name">{m['name']} <span style="font-size:11px;color:var(--text-muted);">({sym})</span></div>
                <span class="tag tag-green">{cat_tag}</span>
                {acc_badge}
              </div>
              <span class="tag tag-blue">{strat_tag}</span>
            </div>

            <!-- Physics Momentum Radar Mini-Bar -->
            <div class="target-card-physics">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <span style="font-size:11px;color:#38bdf8;font-weight:600;">⚛️ 动量雷达</span>
                {card_badge_html}
              </div>
              <div class="physics-mini-bars">
                <div class="mini-bar-row">
                  <span class="mini-bar-title">季线(60D): <strong>{p_rank60:.1f}%</strong></span>
                  <div class="mini-bar-track"><div class="mini-bar-fill {fill_cls_60}" style="width:{p_rank60}%"></div></div>
                </div>
                <div class="mini-bar-row">
                  <span class="mini-bar-title">年线(250D): <strong>{p_rank250:.1f}%</strong></span>
                  <div class="mini-bar-track"><div class="mini-bar-fill {fill_cls_250}" style="width:{p_rank250}%"></div></div>
                </div>
              </div>
              <div class="physics-mini-metrics">
                <span>速度 <i>v</i>: <strong class="{v_cls}">{v_str}</strong></span>
                <span>质量 <i>m</i>: <strong class="{m_cls}">{m_str}</strong></span>
                <span>置信合力 <i>F<sub>eff</sub></i>: <strong class="{feff_cls}">{feff_str}</strong> {conf_badge}</span>
              </div>
            </div>

            <div class="target-card-stats">
              <div>持仓: <strong>{qty_str}</strong></div>
              <div>成本: <strong>{cost_str}</strong></div>
              <div>现价: <strong data-field="price">{curr_p_str}</strong></div>
              <div>市值: <strong data-field="mkt">{mkt_val_str}</strong></div>
              <div>浮动盈亏: <strong data-field="pnl" class="{fpnl_class}">{fpnl_str}</strong></div>
              <div>持仓盈亏率: <strong data-field="rate" class="{rr_class}">{rr_str}</strong></div>
              <div>本息倍数: <strong data-field="mult" class="{mult_class}">{mult_str}</strong></div>
              <div>做T战绩: <strong class="{win_class}">{t_stats_str}</strong></div>
            </div>
            <div style="font-size: 12px; color: #cbd5e1; line-height: 1.5;">
              • <strong>操盘策略</strong>：{strat_desc}
            </div>
            <div class="target-card-hint">
              👆 点击穿透查看 {total_lots_count} 笔批次明细 (按买入时间排序) →
            </div>
          </div>"""

for sym in sorted_syms_by_mkt:
    sym_lots = active_lots_by_sym.get(sym, {})

    all_lots_for_sym = all_lots_by_sym.get(sym, [])
    sym_accounts = [a for a in REAL_ACCOUNTS if sym_lots.get(a) or any(l["account_id"] == a for l in all_lots_for_sym)]

    target_js_data[sym] = {
        "ALL": {
            **target_metrics_all[sym],
            "account_id": "ALL",
            "account_label": account_label("ALL"),
            "category": SYMBOL_NOTES.get(sym, DEFAULT_SYMBOL_NOTE)[0],
            "strategy": build_strategy_note(target_metrics_all[sym], SYMBOL_NOTES.get(sym, DEFAULT_SYMBOL_NOTE)[1]),
            "physics": physics_by_sym.get(sym),
            "lots": all_lots_for_sym
        }
    }

    for acc in sym_accounts:
        acc_lots_for_sym = [l for l in all_lots_for_sym if l["account_id"] == acc]
        target_js_data[sym][acc] = {
            **(target_metrics.get(acc, {}).get(sym) or target_metrics_all[sym]),
            "account_id": acc,
            "account_label": account_label(acc),
            "category": SYMBOL_NOTES.get(sym, DEFAULT_SYMBOL_NOTE)[0],
            "strategy": build_strategy_note(
                target_metrics.get(acc, {}).get(sym) or target_metrics_all[sym],
                SYMBOL_NOTES.get(sym, DEFAULT_SYMBOL_NOTE)[1],
            ),
            "physics": physics_by_sym.get(sym),
            "lots": acc_lots_for_sym
        }

    if len(sym_accounts) > 1:
        # Overlapping symbol held in several accounts: merged card + one card per account.
        target_cards_html.append(build_single_card(sym, target_metrics_all[sym], "ALL", "ALL", is_hidden=False))
        for acc in sym_accounts:
            acc_m = target_metrics.get(acc, {}).get(sym)
            if acc_m:
                target_cards_html.append(build_single_card(sym, acc_m, acc, acc, is_hidden=True))
    elif len(sym_accounts) == 1:
        acc = sym_accounts[0]
        acc_m = target_metrics.get(acc, {}).get(sym)
        if acc_m:
            target_cards_html.append(build_single_card(sym, acc_m, acc, f"ALL,{acc}", is_hidden=False))
    else:
        target_cards_html.append(build_single_card(sym, target_metrics_all[sym], "ALL", "ALL", is_hidden=False))

target_cards_block = chr(10).join(target_cards_html)

# Generate Tab: Active Holdings table rows
total_active_mkt_all = sum(target_metrics_all[s]["market_value"] for s in active_syms_list)

holdings_active_syms = sorted(
    active_syms_list,
    key=lambda s: target_metrics_all[s]["return_rate"],
    reverse=True
)

rows_holdings_html = []
current_initial_rank = 1

def build_single_holding_row(sym, m, acc_mode, visibility, is_hidden=False, initial_idx=1):
    name = m["name"]
    cat_tag, strat_tag, border_col = SYMBOL_NOTES.get(sym, DEFAULT_SYMBOL_NOTE)
    strat_desc = build_strategy_note(m, strat_tag)

    qty_str = f"{m['shares']:,} {m['qty_unit']}"
    cost_str = f"¥{m['cost_unit']:.3f}" if m['cost_unit'] < 2.0 else f"¥{m['cost_unit']:.2f}"
    curr_p_str = f"¥{m['current_price']:.3f}" if m['current_price'] < 2.0 else f"¥{m['current_price']:.2f}"
    tot_cost = m['cost_unit'] * m['shares']
    tot_cost_str = f"¥{tot_cost:,.2f}"
    mkt_val = m['market_value']
    mkt_val_str = f"¥{mkt_val:,.2f}"

    fpnl = m['floating_pnl']
    fpnl_class = "val-green" if fpnl >= 0 else "val-red"
    fpnl_str = f"-¥{abs(fpnl):,.2f}" if fpnl < 0 else (f"+¥{fpnl:,.2f}" if fpnl > 0 else "¥0.00")

    rr = m['return_rate']
    rr_class = "val-green" if rr >= 0 else "val-red"
    rr_prefix = "+" if rr > 0 else ""
    rr_str = f"{rr_prefix}{rr*100:.2f}%"

    mult = (mkt_val / tot_cost) if tot_cost > 0 else 1.0
    mult_class = "val-green" if mult >= 1.0 else "val-red"
    mult_str = f"{mult:.2f}x"

    weight = (mkt_val / total_active_mkt_all * 100) if total_active_mkt_all > 0 else 0
    weight_str = f"{weight:.2f}%"

    p_row = physics_by_sym.get(sym) or {}
    badge_table = format_physics_badge_table(p_row)
    rank250_val = p_row.get("pct_rank_250", 50.0)
    rank250_cls = "val-green" if rank250_val <= 20 else ("val-purple" if rank250_val >= 80 else "")

    tbl_acc_badge = acc_badge_html(acc_mode, compact=True)

    display_style = 'style="display:none;"' if is_hidden else ''
    rank_disp = str(initial_idx) if not is_hidden else '-'

    return f"""              <tr data-symbol="{sym}" data-account-visibility="{visibility}" data-account="{acc_mode}" data-qty="{m['shares']}" data-lots="{m['active_lots_count']}" data-pnl-rate="{rr}" data-pnl-val="{fpnl}" data-mkt-val="{mkt_val}" data-cost-val="{tot_cost}" data-rank-250="{rank250_val:.2f}" {display_style}>
                <td class="rank-cell">{rank_disp}</td>
                <td>{tbl_acc_badge}</td>
                <td><code>{sym}</code></td>
                <td><strong>{name}</strong></td>
                <td><span class="tag tag-green">{cat_tag}</span></td>
                <td>{qty_str}</td>
                <td>{cost_str}</td>
                <td><strong data-field="price">{curr_p_str}</strong></td>
                <td>{tot_cost_str}</td>
                <td><strong data-field="mkt">{mkt_val_str}</strong></td>
                <td><strong data-field="pnl" class="{fpnl_class}">{fpnl_str}</strong></td>
                <td><strong data-field="rate" class="{rr_class}">{rr_str}</strong></td>
                <td><strong data-field="mult" class="{mult_class}">{mult_str}</strong></td>
                <td>{weight_str}</td>
                <td>{badge_table}</td>
                <td><strong class="{rank250_cls}">{rank250_val:.1f}%</strong></td>
                <td><span class="tag tag-blue">{strat_tag}</span></td>
                <td><button class="subview-btn" style="padding:2px 8px;font-size:11px;" onclick="openTargetModal('{sym}')">🎯 穿透明细</button></td>
              </tr>"""

for sym in holdings_active_syms:
    sym_lots = active_lots_by_sym.get(sym, {})
    sym_accounts = [a for a in REAL_ACCOUNTS if sym_lots.get(a)]

    if len(sym_accounts) > 1:
        rows_holdings_html.append(build_single_holding_row(sym, target_metrics_all[sym], "ALL", "ALL", is_hidden=False, initial_idx=current_initial_rank))
        current_initial_rank += 1
        for acc in sym_accounts:
            acc_m = target_metrics.get(acc, {}).get(sym)
            if acc_m:
                rows_holdings_html.append(build_single_holding_row(sym, acc_m, acc, acc, is_hidden=True))
    elif len(sym_accounts) == 1:
        acc = sym_accounts[0]
        acc_m = target_metrics.get(acc, {}).get(sym)
        if acc_m:
            rows_holdings_html.append(build_single_holding_row(sym, acc_m, acc, f"ALL,{acc}", is_hidden=False, initial_idx=current_initial_rank))
            current_initial_rank += 1
    else:
        rows_holdings_html.append(build_single_holding_row(sym, target_metrics_all[sym], "ALL", "ALL", is_hidden=False, initial_idx=current_initial_rank))
        current_initial_rank += 1

tbody_holdings = chr(10).join(rows_holdings_html)

# Generate Tab 3 Active lots rows (time dimension)
rows_time_html = []
for idx, lot in enumerate(lots_active_data, 1):
    sym = lot["symbol"]
    name = lot["symbol_name"]
    lot_id = lot["lot_id"]
    buy_date = lot["buy_time"][:10]
    buy_p = f"¥{lot['buy_price']:.3f}" if lot['buy_price'] < 2.0 else f"¥{lot['buy_price']:.2f}"
    curr_p = f"¥{lot['current_price']:.3f}" if lot['current_price'] < 2.0 else f"¥{lot['current_price']:.2f}"
    qty_unit = "份" if "ETF" in name or "LOF" in name else "股"
    qty_str = f"{lot['remaining_quantity']:,} {qty_unit}"
    pnl = lot["floating_pnl"]
    pnl_class = "val-green" if pnl >= 0 else "val-red"
    pnl_prefix = "+" if pnl > 0 else ""
    pnl_str = f"{pnl_prefix}¥{pnl:,.2f}"
    rr = lot["return_rate"]
    rr_class = "val-green" if rr >= 0 else "val-red"
    rr_prefix = "+" if rr > 0 else ""
    rr_str = f"{rr_prefix}{rr*100:.2f}%"

    if rr > 0.15:
        strat = '<span class="tag tag-green">[跟踪止盈]</span>'
    elif rr > 0.0:
        strat = '<span class="tag tag-green">[持仓观察]</span>'
    elif rr > -0.10:
        strat = '<span class="tag tag-blue">[微亏防守]</span>'
    elif rr > -0.20:
        strat = '<span class="tag tag-amber">[待加仓/观察]</span>'
    elif rr > -0.50:
        strat = '<span class="tag tag-blue">[深跌击球]</span>'
    else:
        strat = '<span class="tag tag-purple">[山顶代冲消融]</span>'

    lot_acc = acct_of(lot.get("account_id"))
    acc_badge = acc_badge_html(lot_acc, compact=True)
    buy_reason_title = f' title="买入理由: {html.escape(lot.get("buy_reason") or "未记录")}"'
    rows_time_html.append(f"""              <tr data-symbol="{sym}" data-lot-id="{lot_id}" data-status="ACTIVE" data-qty="{lot['remaining_quantity']}" data-cost-unit="{lot['cost_basis_unit']}" data-account="{lot_acc}"{buy_reason_title}>
      <td class="rank-cell">{idx}</td>
      <td>{acc_badge}</td>
      <td><strong>{name}</strong> <span style="color:#94a3b8;font-size:11px;">({sym})</span></td>
      <td><code>{lot_id}</code></td>
      <td>{buy_date}</td>
      <td>{buy_p}</td>
      <td><strong data-field="price">{curr_p}</strong></td>
      <td>{qty_str}</td>
      <td><strong data-field="pnl" class="{pnl_class}">{pnl_str}</strong></td>
      <td><strong data-field="rate" class="{rr_class}">{rr_str}</strong></td>
      <td>{strat}</td>
    </tr>""")

tbody_time = chr(10).join(rows_time_html)

# Ranked by PnL
lots_by_pnl = sorted(lots_active_data, key=lambda x: x["return_rate"], reverse=True)
rows_pnl_html = []
for idx, lot in enumerate(lots_by_pnl, 1):
    sym = lot["symbol"]
    name = lot["symbol_name"]
    lot_id = lot["lot_id"]
    buy_date = lot["buy_time"][:10]
    buy_p = f"¥{lot['buy_price']:.3f}" if lot['buy_price'] < 2.0 else f"¥{lot['buy_price']:.2f}"
    curr_p = f"¥{lot['current_price']:.3f}" if lot['current_price'] < 2.0 else f"¥{lot['current_price']:.2f}"
    qty_unit = "份" if "ETF" in name or "LOF" in name else "股"
    qty_str = f"{lot['remaining_quantity']:,} {qty_unit}"
    pnl = lot["floating_pnl"]
    pnl_class = "val-green" if pnl >= 0 else "val-red"
    pnl_prefix = "+" if pnl > 0 else ""
    pnl_str = f"{pnl_prefix}¥{pnl:,.2f}"
    rr = lot["return_rate"]
    rr_class = "val-green" if rr >= 0 else "val-red"
    rr_prefix = "+" if rr > 0 else ""
    rr_str = f"{rr_prefix}{rr*100:.2f}%"

    if rr > 0.15:
        strat = '<span class="tag tag-green">[跟踪止盈]</span>'
    elif rr > 0.0:
        strat = '<span class="tag tag-green">[持仓观察]</span>'
    elif rr > -0.10:
        strat = '<span class="tag tag-blue">[微亏防守]</span>'
    elif rr > -0.20:
        strat = '<span class="tag tag-amber">[待加仓/观察]</span>'
    elif rr > -0.50:
        strat = '<span class="tag tag-blue">[深跌击球]</span>'
    else:
        strat = '<span class="tag tag-purple">[山顶代冲消融]</span>'

    lot_acc = acct_of(lot.get("account_id"))
    acc_badge = acc_badge_html(lot_acc, compact=True)
    buy_reason_title = f' title="买入理由: {html.escape(lot.get("buy_reason") or "未记录")}"'
    rows_pnl_html.append(f"""              <tr data-symbol="{sym}" data-lot-id="{lot_id}" data-status="ACTIVE" data-qty="{lot['remaining_quantity']}" data-cost-unit="{lot['cost_basis_unit']}" data-account="{lot_acc}"{buy_reason_title} data-return="{rr}">
      <td class="rank-cell">{idx}</td>
      <td>{acc_badge}</td>
      <td><strong>{name}</strong> <span style="color:#94a3b8;font-size:11px;">({sym})</span></td>
      <td><code>{lot_id}</code></td>
      <td>{buy_date}</td>
      <td>{buy_p}</td>
      <td><strong data-field="price">{curr_p}</strong></td>
      <td>{qty_str}</td>
      <td><strong data-field="pnl" class="{pnl_class}">{pnl_str}</strong></td>
      <td><strong data-field="rate" class="{rr_class}">{rr_str}</strong></td>
      <td>{strat}</td>
    </tr>""")

tbody_pnl = chr(10).join(rows_pnl_html)

# Generate Tab 4 Closed Trades rows
rows_trades_html = []
for idx, tr in enumerate(closed_trades_raw, 1):
    tr_id, name, sym, buy_time, buy_p, exec_time, sell_p, qty, pnl, action, tr_acc, tr_reason = tr
    buy_d = buy_time[:10]
    sell_d = exec_time[:10]
    qty_unit = "份" if "ETF" in name or "LOF" in name else "股"
    qty_str = f"{qty:,} {qty_unit}"
    pnl_class = "val-green" if pnl >= 0 else "val-red"
    pnl_prefix = "+" if pnl > 0 else ""
    pnl_str = f"{pnl_prefix}¥{pnl:,.2f}"
    rr = (sell_p - buy_p) / buy_p if buy_p > 0 else 0
    rr_class = "val-green" if rr >= 0 else "val-red"
    rr_prefix = "+" if rr > 0 else ""
    rr_str = f"{rr_prefix}{rr*100:.2f}%"

    if pnl < 0:
        tag = '<span class="tag tag-red">微损止损</span>'
    elif rr >= 0.10:
        tag = '<span class="tag tag-green">大幅止盈</span>'
    elif rr >= 0.04:
        tag = '<span class="tag tag-green">波段止盈落袋</span>'
    else:
        tag = '<span class="tag tag-blue">底仓代冲做T</span>'

    p_buy_fmt = f"¥{buy_p:.3f}" if buy_p < 2.0 else f"¥{buy_p:.2f}"
    p_sell_fmt = f"¥{sell_p:.3f}" if sell_p < 2.0 else f"¥{sell_p:.2f}"

    trade_acc = acct_of(tr_acc)
    acc_badge = acc_badge_html(trade_acc, compact=True)
    trade_reason_title = f' title="平仓理由: {html.escape(tr_reason or "未记录")}"'
    rows_trades_html.append(f"""              <tr data-symbol="{sym}" data-account="{trade_acc}"{trade_reason_title}>
      <td>{idx}</td>
      <td>{acc_badge}</td>
      <td><strong>{name}</strong> <span style="color:#94a3b8;font-size:11px;">({sym})</span></td>
      <td>{buy_d} ({p_buy_fmt})</td>
      <td>{sell_d} ({p_sell_fmt})</td>
      <td>{qty_str}</td>
      <td><strong class="{pnl_class}">{pnl_str}</strong></td>
      <td><strong class="{rr_class}">{rr_str}</strong></td>
      <td>{tag}</td>
    </tr>""")

tbody_trades = chr(10).join(rows_trades_html)

# Symbol select options for Tab 3 filter
symbol_options = [f'<option value="ALL">全部 {len(sorted_syms_by_mkt)} 大标的 ({len(lots_active_data)} 笔在场活跃批次)</option>']
for s in sorted_syms_by_mkt:
    m = target_metrics_all[s]
    symbol_options.append(f'<option value="{s}">{m["name"]} ({s}) - {m["active_lots_count"]} 笔活跃批次</option>')
symbol_select_options_html = chr(10).join(symbol_options)

# Global Core symbols for macro KPI
GLOBAL_CORE_SYMBOLS = {'513300.SH', '513500.SH', '518880.SH', '513880.SH', '513080.SH', '513030.SH'}

# Compute complete ACCOUNT_METRICS for the merged view + every discovered account
account_metrics = {}
for acc in ACCOUNT_KEYS:
    if acc == 'ALL':
        acc_lots = lots_active_data
        acc_trades = closed_trades_raw
        div_sum = sum(sum(v.values()) for v in DIVIDENDS_BY_SYM_AND_ACC.values())
    else:
        acc_lots = [l for l in lots_active_data if acct_of(l.get('account_id')) == acc]
        acc_trades = [t for t in closed_trades_raw if acct_of(t[10]) == acc]
        div_sum = sum(v.get(acc, 0.0) for v in DIVIDENDS_BY_SYM_AND_ACC.values())

    active_syms = set(l['symbol'] for l in acc_lots)
    total_active_syms = len(active_syms)
    total_active_lots = len(acc_lots)

    cost_val = sum(l['remaining_quantity'] * l['cost_basis_unit'] for l in acc_lots)
    mkt_val = sum(l['remaining_quantity'] * l['current_price'] for l in acc_lots)
    pnl_val = sum(l['floating_pnl'] for l in acc_lots)
    pnl_rate = (pnl_val / cost_val) if cost_val > 0 else 0.0
    mult_val = (mkt_val / cost_val) if cost_val > 0 else 1.0

    tr_cnt = len(acc_trades)
    win_cnt = sum(1 for t in acc_trades if t[8] > 0)
    loss_cnt = sum(1 for t in acc_trades if t[8] < 0)
    real_pnl = sum(t[8] for t in acc_trades)
    win_rate = (win_cnt / tr_cnt * 100) if tr_cnt > 0 else 0.0
    win_sum = sum(t[8] for t in acc_trades if t[8] > 0)
    loss_sum = sum(abs(t[8]) for t in acc_trades if t[8] < 0)
    if tr_cnt == 0:
        pf_str = "--"
    elif loss_cnt == 0:
        pf_str = "全胜"
    else:
        pf = win_sum / loss_sum if loss_sum > 0 else 999.0
        pf_str = f"{pf:.2f}"

    total_withdrawn = real_pnl + div_sum

    sym_lots_map = {}
    for l in acc_lots:
        s = l['symbol']
        if s not in sym_lots_map:
            sym_lots_map[s] = []
        sym_lots_map[s].append(l)

    pos_syms = []
    neg_syms = []
    for s, lots in sym_lots_map.items():
        spnl = sum(l['floating_pnl'] for l in lots)
        if spnl >= 0:
            pos_syms.append(spnl)
        else:
            neg_syms.append(spnl)

    pos_sum = sum(pos_syms)
    neg_sum = sum(neg_syms)

    global_lots = [l for l in acc_lots if l['symbol'] in GLOBAL_CORE_SYMBOLS]
    global_pnl = sum(l['floating_pnl'] for l in global_lots)

    pnl_cls = "val-green" if pnl_val >= 0 else "val-red"
    pnl_pfx = "+" if pnl_val > 0 else ""

    account_metrics[acc] = {
        "acc": acc,
        "label": account_label(acc),
        "short_label": account_short_label(acc),
        "active_syms_count": total_active_syms,
        "active_lots_count": total_active_lots,
        "cost_val": cost_val,
        "cost_str": f"¥{cost_val:,.2f}",
        "mkt_val": mkt_val,
        "mkt_str": f"¥{mkt_val:,.2f}",
        "mkt_w_str": f"{mkt_val/10000:.2f} 万",
        "pnl_val": pnl_val,
        "pnl_str": f"{pnl_pfx}¥{pnl_val:,.2f} ({pnl_rate*100:.2f}%)",
        "pnl_cls": pnl_cls,
        "multiple_str": f"{mult_val:.2f}x",
        "closed_trades_count": tr_cnt,
        "win_trades_count": win_cnt,
        "loss_trades_count": loss_cnt,
        "realized_pnl_val": real_pnl,
        "realized_pnl_str": f"{'+' if real_pnl >= 0 else ''}¥{real_pnl:,.2f}",
        "win_rate_str": f"{win_rate:.2f}%",
        "win_loss_ratio_str": pf_str,
        "dividends_val": div_sum,
        "dividends_str": f"+¥{div_sum:,.2f}",
        "withdrawn_val": total_withdrawn,
        "withdrawn_str": f"+¥{total_withdrawn:,.2f}",
        "pos_count": len(pos_syms),
        "neg_count": len(neg_syms),
        "pos_sum_str": f"+¥{pos_sum/10000:.2f}万",
        "neg_sum_str": f"¥{neg_sum/10000:.2f}万",
        "global_pnl_str": f"+¥{global_pnl/10000:.2f} 万" if global_pnl >= 0 else f"-¥{abs(global_pnl)/10000:.2f} 万",
    }

# ---------------------------------------------------------------------------
# 三大支柱（全动态）
#
# Everything below is derived from the ledger's *real* asset classification
# (`symbols.asset_class`) and the caller's account slice. The template owns nothing but the
# card skeleton: no historical number, no private symbol literal, no fixed percentage is
# baked in here or in template_base.html. An empty / unclassified book renders a neutral,
# structured placeholder instead of guessing.
# ---------------------------------------------------------------------------

PILLAR_CLASS_ORDER = ["ETF", "STOCK"]
PILLAR_CLASS_LABELS = {
    "ETF": "📦 交易型基金（ETF/LOF）层",
    "STOCK": "🧱 个股底层",
    "UNCLASSIFIED": "❔ 未归类资产层",
}
PILLAR_CLASS_THEMES = {
    "ETF": ("var(--green)", "val-green"),
    "STOCK": ("var(--blue)", "val-blue"),
    "UNCLASSIFIED": ("var(--amber)", "val-amber"),
}
PILLAR_FALLBACK_THEMES = [
    ("var(--purple)", "val-purple"),
    ("var(--red)", "val-red"),
    ("var(--green)", "val-green"),
]


def asset_class_of(sym):
    """Real asset class from the ledger's `symbols` table; blank -> UNCLASSIFIED."""
    info = symbols_map.get(sym) or {}
    raw = str(info.get("asset_class") or "").strip().upper()
    return raw or "UNCLASSIFIED"


def aggregate_by_class(metrics_map):
    """Bucket active in-book positions by their real asset class. No hardcoded symbol list."""
    buckets = {}
    for sym, m in metrics_map.items():
        shares = float(m.get("shares") or 0)
        if shares <= 0:
            continue  # only positions actually on the book count toward allocation
        code = asset_class_of(sym)
        b = buckets.setdefault(code, {"mkt": 0.0, "cost": 0.0, "pnl": 0.0, "lots": 0, "syms": {}})
        mkt = float(m.get("market_value") or 0)
        b["mkt"] += mkt
        b["cost"] += float(m.get("cost_unit") or 0) * shares
        b["pnl"] += float(m.get("floating_pnl") or 0)
        b["lots"] += int(m.get("active_lots_count") or 0)
        b["syms"][sym] = b["syms"].get(sym, 0.0) + mkt
    return buckets


def money_wan(v, signed=False):
    v = float(v or 0)
    sign = "+" if (signed and v > 0) else ("-" if v < 0 else "")
    return f"{sign}¥{abs(v) / 10000:,.2f} 万元"


def money_yuan(v):
    v = float(v or 0)
    sign = "+" if v > 0 else ("-" if v < 0 else "")
    return f"{sign}¥{abs(v):,.2f}"


def _pct(v):
    if v is None:
        return "--"
    return f"{v * 100:+.2f}%" if v < 0 or v > 0 else "0.00%"


def _stat_cell(label, value, klass=None):
    cls_attr = f' class="{klass}"' if klass else ""
    return f"<div>{label}: <strong{cls_attr}>{value}</strong></div>"


def render_class_card(code, bucket, total_mkt, theme_index):
    """Render one asset-class pillar card, always from the caller's live numbers."""
    label = PILLAR_CLASS_LABELS.get(code, f"📁 {html.escape(code)} 资产层")
    border, ratio_cls = PILLAR_CLASS_THEMES.get(
        code, PILLAR_FALLBACK_THEMES[theme_index % len(PILLAR_FALLBACK_THEMES)]
    )
    bucket = bucket or {"mkt": 0.0, "cost": 0.0, "pnl": 0.0, "lots": 0, "syms": {}}
    mkt = float(bucket["mkt"])
    cost = float(bucket["cost"])
    pnl = float(bucket["pnl"])
    has_position = mkt > 0 or bool(bucket["syms"])

    ratio = (mkt / total_mkt) if total_mkt > 0 else None
    ratio_str = f"{ratio * 100:.1f}%" if ratio is not None else "--"
    pnl_cls = "val-green" if pnl >= 0 else "val-red"
    rate = (pnl / cost) if cost > 0 else None
    rate_cls = "val-green" if (rate or 0) >= 0 else "val-red"

    if has_position:
        desc = (
            f"按账本 asset_class={html.escape(code)} 动态聚合：共 {len(bucket['syms'])} 只在场标的、"
            f"{bucket['lots']} 笔在场批次，全部数值实时取自本机 SQLite 账本。"
        )
        leaders = sorted(bucket["syms"].items(), key=lambda kv: kv[1], reverse=True)[:3]
        leader_bits = []
        for sym, value in leaders:
            weight = (value / total_mkt * 100) if total_mkt > 0 else 0.0
            name = (symbols_map.get(sym) or {}).get("name") or sym
            leader_bits.append(f"{html.escape(str(name))} ({html.escape(sym)}) {weight:.1f}%")
        desc += " 市值权重前三：" + " • ".join(leader_bits) + "。"
        stats = [
            _stat_cell("持仓市值", money_wan(mkt)),
            _stat_cell("组合占比", f"{ratio * 100:.2f}%" if ratio is not None else "--"),
            _stat_cell("累计浮盈", money_wan(pnl, signed=True), pnl_cls),
            _stat_cell("浮盈率", _pct(rate), rate_cls),
        ]
    else:
        desc = (
            f"当前账本暂无 asset_class={html.escape(code)} 的在场持仓。此处保持中性结构化占位："
            f"不推测、不沿用任何历史数字，待账本出现该类持仓后自动填充。"
        )
        stats = [
            _stat_cell("持仓市值", "¥0.00 万元"),
            _stat_cell("组合占比", "--"),
            _stat_cell("累计浮盈", "¥0.00 万元"),
            _stat_cell("浮盈率", "--"),
        ]

    stats_html = "\n              ".join(stats)
    card_html = f'''          <div class="alloc-card" data-alloc-class="{html.escape(code)}" style="border-top: 4px solid {border};">
            <div class="alloc-head">
              <div class="alloc-title">{label}</div>
              <div class="alloc-ratio {ratio_cls}" id="alloc-class-{html.escape(code)}-ratio">{ratio_str}</div>
            </div>
            <div class="alloc-desc" id="alloc-class-{html.escape(code)}-desc">{desc}</div>
            <div class="alloc-stats" id="alloc-class-{html.escape(code)}-stats">
              {stats_html}
            </div>
          </div>'''
    return card_html, {
        "ratio_str": ratio_str,
        "ratio_cls": ratio_cls,
        "desc": desc,
        "stats_html": stats_html,
    }


def render_cash_card(acc_m, total_mkt):
    """批次消融与现金回收层：cash recycling from the trades / dividends journals."""
    real = float(acc_m.get("realized_pnl_val") or 0)
    dividends = float(acc_m.get("dividends_val") or 0)
    withdrawn = float(acc_m.get("withdrawn_val") or 0)
    base = withdrawn + float(total_mkt or 0)
    ratio = (withdrawn / base) if base > 0 else None
    ratio_str = f"{ratio * 100:.1f}%" if ratio is not None else "--"
    desc = (
        "批次消融与现金回收层：由账本 trades / dividends 表实时汇总。"
        f"已提现现金 {money_yuan(withdrawn)}，在场市值 {money_wan(total_mkt)}；"
        "占比 = 已落袋现金 ÷（已落袋现金 + 在场市值），衡量现金回收程度。"
    )
    stats = [
        _stat_cell("做T净利", acc_m["realized_pnl_str"], "val-green" if real >= 0 else "val-red"),
        _stat_cell("累计分红", acc_m["dividends_str"], "val-green"),
        _stat_cell("已提现现金", acc_m["withdrawn_str"], "val-green" if withdrawn >= 0 else "val-red"),
        _stat_cell(
            "平仓战绩",
            f"{acc_m['closed_trades_count']}战{acc_m['win_trades_count']}胜 ({acc_m['win_rate_str']})",
            "val-green",
        ),
    ]
    stats_html = "\n              ".join(stats)
    card_html = f'''          <div class="alloc-card" data-alloc-class="CASH" style="border-top: 4px solid var(--purple);">
            <div class="alloc-head">
              <div class="alloc-title">🎯 批次消融与现金回收层</div>
              <div class="alloc-ratio val-purple" id="alloc-class-CASH-ratio">{ratio_str}</div>
            </div>
            <div class="alloc-desc" id="alloc-class-CASH-desc">{desc}</div>
            <div class="alloc-stats" id="alloc-class-CASH-stats">
              {stats_html}
            </div>
          </div>'''
    return card_html, {
        "ratio_str": ratio_str,
        "ratio_cls": "val-purple",
        "desc": desc,
        "stats_html": stats_html,
    }


# Union of every class that appears in any account slice, then the canonical ones, so the
# card layout is stable across the account switcher without ever inventing a category.
ALL_CLASS_CODES = []
for _acc_key in ACCOUNT_KEYS:
    for _code in aggregate_by_class(target_metrics.get(_acc_key, {})).keys():
        if _code not in ALL_CLASS_CODES:
            ALL_CLASS_CODES.append(_code)
for _code in PILLAR_CLASS_ORDER:
    if _code not in ALL_CLASS_CODES:
        ALL_CLASS_CODES.append(_code)
ALL_CLASS_CODES.sort(
    key=lambda c: (PILLAR_CLASS_ORDER.index(c) if c in PILLAR_CLASS_ORDER else 99, c)
)

alloc_pillars_cards = []
alloc_class_metrics = {}
for _acc_key in ACCOUNT_KEYS:
    _buckets = aggregate_by_class(target_metrics.get(_acc_key, {}))
    _total_mkt = sum(b["mkt"] for b in _buckets.values())
    _acc_payload = {}
    for _idx, _code in enumerate(ALL_CLASS_CODES):
        _card_html, _card_payload = render_class_card(
            _code, _buckets.get(_code), _total_mkt, _idx
        )
        if _acc_key == "ALL":
            alloc_pillars_cards.append(_card_html)
        _acc_payload[_code] = _card_payload
    _cash_html, _cash_payload = render_cash_card(account_metrics[_acc_key], _total_mkt)
    if _acc_key == "ALL":
        alloc_pillars_cards.append(_cash_html)
    _acc_payload["CASH"] = _cash_payload
    alloc_class_metrics[_acc_key] = _acc_payload

alloc_pillars_html = "\n".join(alloc_pillars_cards)
alloc_class_metrics_json = json.dumps(alloc_class_metrics, ensure_ascii=False)

# Convert data to JSON string for client-side embedding
account_metrics_json = json.dumps(account_metrics, ensure_ascii=False)
target_js_json = json.dumps(target_js_data, ensure_ascii=False)

print("HTML Components prepared. Assembling full page...")

# Assemble the HTML template
with open(template_path, "r", encoding="utf-8") as tf:
    html_template = tf.read()

# Dynamic Placeholders interpolation
m_all = account_metrics["ALL"]

# ---- account switcher + split summaries (fully data-driven, zero broker literals) ----
account_filter_buttons = [
    f'<button id="btn-acc-all" class="subview-btn active" style="padding:6px 14px;font-size:12px;" '
    f'onclick="setGlobalAccountFilter(\'ALL\')">🌐 全账户合并 ({m_all["active_syms_count"]} 标的 • {m_all["active_lots_count"]} 批次)</button>'
]
for _acc in REAL_ACCOUNTS:
    _m = account_metrics[_acc]
    account_filter_buttons.append(
        f'<button id="btn-acc-{_acc}" class="subview-btn" style="padding:6px 14px;font-size:12px;" '
        f'onclick="setGlobalAccountFilter(\'{_acc}\')">🏛 {html.escape(account_short_label(_acc))} {html.escape(_acc)} '
        f'({_m["active_syms_count"]} 标的 • {_m["active_lots_count"]} 批次)</button>'
    )
account_filter_buttons_html = "\n      ".join(account_filter_buttons)

if REAL_ACCOUNTS:
    account_merge_label = " + ".join(account_label(a) for a in REAL_ACCOUNTS)
    account_mkt_w_split = " + ".join(
        f"{html.escape(account_short_label(a))} {account_metrics[a]['mkt_w_str']}" for a in REAL_ACCOUNTS
    )
    account_cost_split = " + ".join(
        f"{html.escape(account_short_label(a))} {account_metrics[a]['cost_str']}" for a in REAL_ACCOUNTS
    )
    account_mkt_split = " + ".join(
        f"{html.escape(account_short_label(a))} {account_metrics[a]['mkt_str']}" for a in REAL_ACCOUNTS
    )
else:
    account_merge_label = "全账户合并"
    account_mkt_w_split = "暂无可穿透账户"
    account_cost_split = "暂无可穿透账户"
    account_mkt_split = "暂无可穿透账户"

html_content = html_template.replace("{{TARGET_CARDS_BLOCK}}", target_cards_block)
html_content = html_content.replace("{{TBODY_HOLDINGS}}", tbody_holdings)
html_content = html_content.replace("{{TBODY_TIME}}", tbody_time)
html_content = html_content.replace("{{TBODY_PNL}}", tbody_pnl)
html_content = html_content.replace("{{TBODY_TRADES}}", tbody_trades)
html_content = html_content.replace("{{SYMBOL_OPTIONS}}", symbol_select_options_html)
html_content = html_content.replace("{{ACCOUNT_METRICS_JSON}}", account_metrics_json)
html_content = html_content.replace("{{ALLOC_CLASS_METRICS_JSON}}", alloc_class_metrics_json)
html_content = html_content.replace("{{ALLOC_PILLARS_HTML}}", alloc_pillars_html)
html_content = html_content.replace("{{TARGET_JS_JSON}}", target_js_json)
html_content = html_content.replace("{{ACCOUNT_FILTER_BUTTONS_HTML}}", account_filter_buttons_html)
html_content = html_content.replace("{{ACCOUNT_MERGE_LABEL}}", html.escape(account_merge_label))
html_content = html_content.replace("{{ACCOUNT_MKT_W_SPLIT_STR}}", account_mkt_w_split)
html_content = html_content.replace("{{ACCOUNT_COST_SPLIT_STR}}", account_cost_split)
html_content = html_content.replace("{{ACCOUNT_MKT_SPLIT_STR}}", account_mkt_split)

# Dynamic Placeholder Tokens
html_content = html_content.replace("{{TOTAL_ACTIVE_SYMBOLS_COUNT}}", str(m_all["active_syms_count"]))
html_content = html_content.replace("{{TOTAL_ACTIVE_LOTS_COUNT}}", str(m_all["active_lots_count"]))
html_content = html_content.replace("{{TOTAL_CLOSED_TRADES_COUNT}}", str(m_all["closed_trades_count"]))
html_content = html_content.replace("{{TOTAL_WIN_TRADES_COUNT}}", str(m_all["win_trades_count"]))
html_content = html_content.replace("{{TOTAL_LOSS_TRADES_COUNT}}", str(m_all["loss_trades_count"]))
html_content = html_content.replace("{{TOTAL_WIN_RATE_STR}}", m_all["win_rate_str"])
html_content = html_content.replace("{{TOTAL_WIN_LOSS_RATIO}}", m_all["win_loss_ratio_str"])

html_content = html_content.replace("{{COMBINED_TOTAL_MKT_STR}}", f"¥{m_all['mkt_val']/10000:.2f} 万")
html_content = html_content.replace("{{COMBINED_TOTAL_COST_STR}}", m_all["cost_str"])
html_content = html_content.replace("{{COMBINED_TOTAL_FLOAT_PNL_STR}}", m_all["pnl_str"])
html_content = html_content.replace("{{COMBINED_TOTAL_FLOAT_PNL_CLS}}", m_all["pnl_cls"])
html_content = html_content.replace("{{COMBINED_TOTAL_MULT_STR}}", m_all["multiple_str"])
html_content = html_content.replace("{{COMBINED_GLOBAL_PNL_STR}}", m_all["global_pnl_str"])
html_content = html_content.replace("{{TOTAL_POS_COUNT}}", str(m_all["pos_count"]))
html_content = html_content.replace("{{TOTAL_NEG_COUNT}}", str(m_all["neg_count"]))
html_content = html_content.replace("{{TOTAL_POS_SUM_STR}}", m_all["pos_sum_str"])
html_content = html_content.replace("{{TOTAL_NEG_SUM_STR}}", m_all["neg_sum_str"])

html_content = html_content.replace("{{TOTAL_REALIZED_PNL_STR}}", m_all["realized_pnl_str"])
html_content = html_content.replace("{{TOTAL_DIVIDENDS_STR}}", m_all["dividends_str"])
html_content = html_content.replace("{{TOTAL_WITHDRAWN_CASH_STR}}", m_all["withdrawn_str"])

# ---- local session credential (0600 handshake) ----
# Injected as a JS string literal so a token containing quotes/backslashes can never break
# out of the assignment. Empty string === "no active credential, stay standalone".
html_content = html_content.replace("{{SESSION_TOKEN_JS_LITERAL}}", json.dumps(session_token))
html_content = html_content.replace(
    "{{SESSION_TOKEN_CONFIGURED}}", "true" if session_token else "false"
)

# ---------------------------------------------------------------------------
# Secure write: the page embeds the 0600 local session credential, so the file itself must
# never be group/world-readable (a default `open(..., "w")` inherits the umask -> 0644 and
# leaks the token to every local user on the box).
# ---------------------------------------------------------------------------

def write_private_file(path, content, mode=0o600):
    """Atomically-ish write `content` with an exact `mode`, ignoring the umask.

    `os.open(..., mode)` only applies at *creation*; a pre-existing wider file keeps its
    old permission bits, so an unconditional `os.chmod` afterwards is required.
    """
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
    finally:
        # Hard-enforce the exact bit pattern even when the file already existed.
        os.chmod(path, mode)
    actual = os.stat(path).st_mode & 0o777
    if actual != mode:
        raise PermissionError(
            f"生成的看板权限位为 {oct(actual)}，但契约要求 {oct(mode)}（同机其他用户不可读）。"
        )
    return actual


out_path = os.path.abspath(args.out)
out_mode = write_private_file(out_path, html_content, 0o600)

print(
    f"Global dashboard successfully generated: {out_path} "
    f"(Size: {os.path.getsize(out_path):,} bytes, Mode: {oct(out_mode)})"
)

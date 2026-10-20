
import sqlite3, json, subprocess, os, sys, argparse

parser = argparse.ArgumentParser(description="Generate Lot Trader Global Dashboard")
parser.add_argument("--out", "-o", default="lot-trader-global-dashboard.html", help="Output HTML file path (default: lot-trader-global-dashboard.html)")
parser.add_argument("--template", "-t", default=None, help="Template HTML path (default: template_base.html in script directory)")
parser.add_argument("--db", default=None, help="SQLite database path (default: ~/.trade/trade.db)")
args = parser.parse_args()

script_dir = os.path.dirname(os.path.abspath(__file__))
template_path = args.template if args.template else os.path.join(script_dir, "template_base.html")
db_path = args.db if args.db else os.environ.get("TRADE_DB_PATH", os.path.expanduser("~/.trade/trade.db"))

# 1. Fetch live active lots from trade CLI
out_lots = subprocess.check_output(["trade", "lot", "list", "--status", "ACTIVE", "--json"])
lots_active_data = json.loads(out_lots.decode("utf-8"))["data"]

# 2. Fetch stats from trade CLI
out_stats = subprocess.check_output(["trade", "stats", "--json"])
stats_data = json.loads(out_stats.decode("utf-8"))["data"]

# 2.5 Fetch positions with physics momentum radar for all 38 targets
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

# Get all symbols
c.execute("SELECT symbol, name, asset_class, settlement_mode FROM symbols ORDER BY symbol")
symbols_raw = c.fetchall()
symbols_map = {r[0]: {"symbol": r[0], "name": r[1], "asset_class": r[2], "settlement_mode": r[3]} for r in symbols_raw}

# Get all lots (ACTIVE and CLOSED)
c.execute("""
SELECT l.lot_id, l.symbol, s.name, s.asset_class, l.buy_time, l.buy_price, 
       l.buy_quantity, l.remaining_quantity, l.cost_basis_unit, l.status,
       l.close_time, l.close_avg_price, l.realized_pnl, l.account_id
FROM lots l
JOIN symbols s ON l.symbol = s.symbol
ORDER BY l.buy_time DESC
""")
all_db_lots = c.fetchall()

# Get all sell trades
c.execute("""
SELECT t.trade_id, s.name, s.symbol, l.buy_time, l.buy_price, t.executed_at, t.price, t.quantity, t.realized_pnl, t.action, t.account_id
FROM trades t
JOIN lots l ON t.lot_id = l.lot_id
JOIN symbols s ON l.symbol = s.symbol
WHERE t.action LIKE "SELL%"
ORDER BY t.executed_at DESC
""")
closed_trades_raw = c.fetchall()

# Verified dividends by symbol
DIVIDENDS_MAP = {
    '600036.SH': 13240.48,
    '600585.SH': 7857.00,
    '600900.SH': 4539.46,
    '002507.SZ': 3215.00,
    '002233.SZ': 1592.00,
    '300529.SZ': 1417.00,
    '600276.SH': 1344.00,
    '002191.SZ': 1323.00,
    '300357.SZ': 1229.00,
    '603260.SH': 1109.00,
    '601398.SH': 783.90,   # CMB 309.00 + PA 474.90
    '600390.SH': 767.00,
    '300677.SZ': 683.00,
    '600586.SH': 467.00,
    '002466.SZ': 435.00,
    '000877.SZ': 398.00,
    '600064.SH': 352.00,   # PA
    '603678.SH': 268.00,
    '300595.SZ': 262.00,
    '601012.SH': 211.00,
    '000623.SZ': 145.00,   # PA
    '002603.SZ': 134.00,
    '002029.SZ': 125.00,
    '000100.SZ': 122.00,
    '300601.SZ': 101.00,
    '000001.SZ': 60.90,    # PA
    '000725.SZ': 42.00,
    '600000.SH': 42.00,    # PA
}

# Group active lots by symbol
active_lots_by_sym = {}
for l in lots_active_data:
    sym = l["symbol"]
    if sym not in active_lots_by_sym:
        active_lots_by_sym[sym] = []
    active_lots_by_sym[sym].append(l)

# Group all lots by symbol for modal & detail
all_lots_by_sym = {}
for r in all_db_lots:
    lid, sym, name, aclass, btime, bp, bqty, rqty, cbu, status, ctime, cp, rpnl, acc_id = r
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
        "account_id": acc_id or "CMB",
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

# Compute per-symbol metrics
target_metrics = {}
for sym, sinfo in symbols_map.items():
    name = sinfo["name"]
    aclass = sinfo["asset_class"]
    unit = "份" if "ETF" in name or "LOF" in name else "股"
    
    # Active position
    act_lots = active_lots_by_sym.get(sym, [])
    if act_lots:
        shares = sum(l["remaining_quantity"] for l in act_lots)
        cost_total = sum(l["remaining_quantity"] * l["cost_basis_unit"] for l in act_lots)
        cost_unit = cost_total / shares if shares > 0 else 0
        cp = curr_prices.get(sym, cost_unit)
        mkt_val = shares * cp
        float_pnl = sum(l["floating_pnl"] for l in act_lots)
        ret_rate = float_pnl / cost_total if cost_total > 0 else 0
    else:
        shares = 0
        cost_total = 0
        cost_unit = 0
        cp = curr_prices.get(sym, 0)
        mkt_val = 0
        float_pnl = 0
        ret_rate = 0
        
    # Trade history from closed_trades_raw
    sym_trades = [t for t in closed_trades_raw if t[2] == sym]
    total_trades = len(sym_trades)
    win_trades = sum(1 for t in sym_trades if t[8] > 0)
    loss_trades = sum(1 for t in sym_trades if t[8] < 0)
    win_pnl = sum(t[8] for t in sym_trades if t[8] > 0)
    loss_pnl = sum(abs(t[8]) for t in sym_trades if t[8] < 0)
    net_t_pnl = win_pnl - loss_pnl
    win_rate = win_trades / total_trades if total_trades > 0 else 0
    
    # Profit factor & Win/loss ratio (盈亏比)
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
        
    div_val = DIVIDENDS_MAP.get(sym, 0.0)
    total_withdrawn = net_t_pnl + div_val
    
    target_metrics[sym] = {
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
        "active_lots_count": len(act_lots),
        "total_lots_count": len(all_lots_by_sym.get(sym, [])),
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

# Specific tags & strategy notes for all 38 symbols
SYMBOL_NOTES = {
    '513300.SH': ('全球核心成长 • 美股科技慢牛', '[跟踪止盈]', 'rgba(16, 185, 129, 0.4)',
                  '两账户在场 94,000 份（招商 84,000 + 平安 10,000），浮盈超 9.3 万元 (+57.0%)，做 T 净利 11,507 元；深厚利润垫完全免疫短期波动，长期跟踪止盈享受科技慢牛复利。'),
    '513500.SH': ('全球核心宽基 • 美股全收益基石', '[跟踪止盈]', 'rgba(16, 185, 129, 0.4)',
                  '两账户在场 62,800 份（招商 59,800 + 平安 3,000），浮盈超 5.9 万元 (+55.3%)，双账户做 T 累计净利 24,380 元；作为组合第一大海外压舱石，坚定长期持有。'),
    '518880.SH': ('避险硬资产 • 央行去美元化底仓', '[跟踪止盈]', 'rgba(16, 185, 129, 0.4)',
                  '在场 18,000 份底仓平均成本 3.693 元（现价 8.46 元），浮盈超 8.5 万元 (+128.9%)，历史 63 战 58 捷盈亏比高达 100.01；守住 $3,910 硬红线底仓坚决不卖。'),
    '513880.SH': ('全球发达市场 • 亚太出口龙头', '[跟踪止盈]', 'rgba(16, 185, 129, 0.4)',
                  '在场 38,500 份浮盈 3.4 万元 (+72.4%)，历史 22 战 21 捷全波段落袋 2,049 元，盈亏比 586.43；全球配置有效分散单一市场风险。'),
    '513080.SH': ('欧洲跨国巨头 • 奢侈品及工业航母', '[跟踪止盈]', 'rgba(16, 185, 129, 0.4)',
                  '在场 4,000 份浮盈 +13.6%，历史 4 战净赚 +35 元；CAC 40 多为跨国营收巨头，弱势欧元反而增厚外币收益，底仓安心持有。'),
    '513030.SH': ('欧洲高端制造 • 德国工业脊梁', '[跟踪止盈]', 'rgba(16, 185, 129, 0.4)',
                  '在场 2,000 份浮盈 +82.0% (+1,576 元)，历史 3 战 3 捷全胜；作为极小规模全球分散配置，享受欧洲高端制造业周期复苏。'),
    '164824.SZ': ('新兴市场敞口 • 人口红利消费', '[待加仓/观察]', 'rgba(245, 158, 11, 0.4)',
                  '双账户合并 70,000 份（招商 4.8w + 平安 2.2w），当前汇率承压磨底，浮亏 -20.8%；严禁盲目左侧接飞刀，静待宏观汇率企稳再行置换。'),
    '513330.SH': ('港股科技龙头 • 深度挤估值磨底', '[代冲消融山顶]', 'rgba(139, 92, 246, 0.4)',
                  '历史 7 战 7 胜做 T 净赚 463 元；在场 72,000 份底仓已完成挤估值，严禁追加外部新钱，依托底仓急跌反弹做 T 冲销历史建仓成本。'),
    '600900.SH': ('水电现金牛 • 绝对防守压舱石', '[跟踪止盈]', 'rgba(16, 185, 129, 0.4)',
                  '在场 2,400 股底仓成本 19.95 元（浮盈 +47.9%），做 T 47 战 45 捷豪取 12,094 元，分红 4,539 元，盈亏比高达 550.73；核心高股息资产长期持有。'),
    '600036.SH': ('零售银行之王 • 高股息分红先锋', '[底仓做T]', 'rgba(16, 185, 129, 0.4)',
                  '在场 1,300 股浮盈 +37.7% (+1.52万)，历年分红高达 13,240 元，累计回笼 9,983 元；依托底仓波段做 T，持续收取丰厚股息。'),
    '601398.SH': ('国有特大行 • 稳健底仓避风港', '[跟踪止盈]', 'rgba(16, 185, 129, 0.4)',
                  '在场 500 股底仓丰厚浮盈 +46.0%，累计分红 309 元；设置移动止盈线，锁定利润同时持续享受高股息现金流。'),
    '002233.SZ': ('高股息水泥 • 9战全胜现金牛', '[底仓做T]', 'rgba(16, 185, 129, 0.4)',
                  '在场 800 股，历史 9 战 9 胜做 T 净赚 766 元，分红 1,592 元，累计回笼现金 2,358 元（占市值 37%）；依托底仓急跌反弹做 T。'),
    '600276.SH': ('创新药旗舰 • 46战44捷做T标杆', '[代冲消融山顶]', 'rgba(59, 130, 246, 0.4)',
                  '在场 1,060 股，做 T 46 战 44 捷豪取 +11,760 元，分红 1,344 元，累计回笼现金超 1.3 万元，盈亏比达 1117.85；依托底仓继续消融山顶。'),
    '600585.SH': ('水泥行业龙头 • 17战全胜分红王', '[分红现金牛]', 'rgba(59, 130, 246, 0.4)',
                  '在场 1,200 股，历史做 T 17 战 17 胜净赚 3,833 元，累计分红 7,857 元，已回笼安全资金 11,690 元（占市值 54%）；依托底仓持续做 T。'),
    '300357.SZ': ('脱敏诊疗龙头 • 21战全胜波段标杆', '[代冲消融山顶]', 'rgba(139, 92, 246, 0.4)',
                  '在场 1,500 股，做 T 21 战 21 胜豪取 6,628 元，分红 1,229 元，累计已提取 7,857 元；严禁外部新钱加仓，依托底仓反弹做 T 冲销山顶。'),
    '002507.SZ': ('大众消费龙头 • 19战18捷稳健做T', '[底仓做T]', 'rgba(59, 130, 246, 0.4)',
                  '在场 1,860 股，做 T 19 战 18 捷净落袋 2,962 元，分红 3,215 元，累计提取现金 6,177 元，盈亏比 44.03；依托底仓急跌反弹锁定差价。'),
    '603260.SH': ('工业硅龙头 • 5战全胜底仓对冲', '[代冲消融山顶]', 'rgba(239, 68, 68, 0.4)',
                  '在场 600 股，历史 5 战 5 胜做 T 净赚 1,737 元，分红 1,109 元，累计提取 2,846 元；严禁盲目抄底，坚决执行底仓代冲策略。'),
    '002191.SZ': ('烟标与新材料 • 4战全胜高分红', '[代冲消融山顶]', 'rgba(139, 92, 246, 0.4)',
                  '在场 1,500 股，做 T 4 战 4 胜净利 +485 元，分红 1,323 元，累计提现 1,808 元；依托底仓急跌反弹做 T 冲销 17.54 元历史山顶。'),
    '300595.SZ': ('眼科医疗龙头 • 4战全胜代冲消融', '[代冲消融山顶]', 'rgba(6, 182, 212, 0.4)',
                  '在场 300 股，历史做 T 4 战全胜净赚 +951 元，分红 262 元，累计回笼 1,213 元；绝对禁止外部新钱补仓，依托底仓对冲山顶。'),
    '601012.SH': ('光伏单晶硅龙头 • 周期底部磨底', '[代冲消融山顶]', 'rgba(34, 197, 94, 0.4)',
                  '在场 300 股，做 T 落袋 +104 元，分红 211 元；光伏周期磨底，严禁外部新钱补仓，依托底仓急跌反弹做 T，定向冲销 56 元山顶批次。'),
    '300529.SZ': ('血液灌流龙头 • 14战全胜利润垫', '[代冲消融山顶]', 'rgba(236, 72, 153, 0.4)',
                  '在场 400 股，做 T 14 战全胜豪取 +8,952 元，分红 1,417 元，已落袋安全现金 +10,369 元！彻底对冲建仓成本，现持仓已被提现利润完全吸收。'),
    '002310.SZ': ('综合工业龙头 • 63战高频做T', '[高频做T防守]', 'rgba(249, 115, 22, 0.4)',
                  '在场 4,100 股，历史做 T 63 战 39 捷总盈利 5,677 元；标的历经多次重组与波动，依托 4,100 股底仓急跌脉冲高频做 T，不追加外部资金。'),
    '600390.SH': ('央企多元金融 • 40战做T极低残仓', '[极小残仓静置]', 'rgba(148, 163, 184, 0.4)',
                  '在场仅剩 120 股残存筹码（市值仅 559 元），历史平仓 40 笔，分红 767 元；占百万总盘比重微乎其微，建议完全静置观望或脉冲清仓。'),
    '000877.SZ': ('西北水泥龙头 • 3战全胜底仓静置', '[代冲消融山顶]', 'rgba(14, 165, 233, 0.4)',
                  '在场 700 股，历史做 T 3 战全胜净赚 +205 元，分红 398 元；水泥周期筑底，严格禁止外部新钱补仓，依托底仓急跌反弹做 T。'),
    '300601.SZ': ('创新疫苗龙头 • 周期筑底静置', '[代冲消融山顶]', 'rgba(239, 68, 68, 0.4)',
                  '在场仅 200 股底仓，历史做 T 1 战全胜落袋 +159 元，分红 101 元；严格杜绝新钱左侧加仓，依托底仓急跌反弹做 T 定向冲销成本。'),
    '000632.SZ': ('低价重组标的 • 9战波段小额防守', '[微仓波段防守]', 'rgba(245, 158, 11, 0.4)',
                  '在场仅 100 股（市值 340 元），历史 9 战 5 捷平分秋色，盈亏比 0.97；仓位极低完全不影响大局，等待退市警示解除或反弹平仓。'),
    '600586.SH': ('超白玻璃龙头 • 14战全胜安全现金', '[底仓代冲做T]', 'rgba(16, 185, 129, 0.4)',
                  '在场 1,600 股，做 T 14 战 14 捷豪取 +2,705 元，分红 +467 元，累计提取安全现金 +3,172 元；依托底仓反弹做 T，定向冲销山顶批次。'),
    '002466.SZ': ('全球锂矿壁垒 • 周期底部持仓观察', '[周期底部观察]', 'rgba(59, 130, 246, 0.4)',
                  '在场仅 100 股底仓，做 T 1 战全胜 +336 元，分红 +435 元，已回笼安全现金 +771 元（市值 3,625 元）；手握底仓等待锂周期供需反转。'),
    '002393.SZ': ('特色制药龙头 • 20战波段微仓防守', '[微仓波段防守]', 'rgba(168, 85, 247, 0.4)',
                  '在场仅 168 股（市值 2,283 元），历史 20 战做 T，止损控仓有效；市值极微对组合无扰动，维持观察。'),
    '002603.SZ': ('现代中药龙头 • 4战全胜底仓防守', '[底仓代冲做T]', 'rgba(16, 185, 129, 0.4)',
                  '在场 300 股底仓，做 T 4 战 4 胜净赚 +797 元，分红 134 元；依托底仓脉冲做 T 锁定利润，禁止追加新钱。'),
    '000100.SZ': ('半导体显示龙头 • 4战全胜底仓做T', '[底仓代冲做T]', 'rgba(59, 130, 246, 0.4)',
                  '在场 2,530 股，做 T 4 战 4 胜净赚 +865 元，分红 122 元；面板周期震荡，依托底仓反弹做 T，逐步消融建仓成本。'),
    '300677.SZ': ('医疗手套龙头 • 5战全胜底仓做T', '[底仓代冲做T]', 'rgba(16, 185, 129, 0.4)',
                  '在场 500 股，做 T 5 战 5 胜净赚 +1,357 元，分红 683 元，累计提现 2,040 元；依托底仓急跌反弹做 T，完全不增加敞口。'),
    '002029.SZ': ('男装品牌消费 • 5战3捷残仓观察', '[微仓观察]', 'rgba(245, 158, 11, 0.4)',
                  '在场仅 100 股（市值 829 元），做 T 5 战 3 捷净利 +365 元，盈亏比 6.29；极微持仓静置，等待反弹减仓。'),
    '600326.SH': ('基建与民爆龙头 • 50战做T残存筹码', '[极小残仓静置]', 'rgba(148, 163, 184, 0.4)',
                  '在场仅 130 股（市值 820 元），历史 50 战做 T 累计总盈利 3,763 元；占总盘比重微乎其微，静置观望即可。'),
    '603678.SH': ('军工电子龙头 • 30战做T利润丰厚', '[跟踪止盈]', 'rgba(16, 185, 129, 0.4)',
                  '在场 500 股浮盈 +88.2% (+8,255 元)，历史 30 战 17 捷做 T 净赚 6,816 元，分红 268 元，盈亏比 1.53；设置移动止盈线锁定丰厚收益。'),
    '000725.SZ': ('面板双雄之一 • 17战做T浮盈观察', '[持仓观察]', 'rgba(16, 185, 129, 0.4)',
                  '在场 2,800 股浮盈 +9.7% (+1,243 元)，历史 17 战做 T；面板周期回暖，浮盈状态持仓观察，伺机移动止盈。'),
    '000792.SZ': ('钾肥锂资源龙头 • 周期回升底仓', '[持仓观察]', 'rgba(59, 130, 246, 0.4)',
                  '在场 300 股成本 24.19 元（现价 22.76 元），浮亏仅 -5.9%，历史做 T 1 战全胜 +277 元；优质资源底仓，耐心等待周期回暖。'),
    '002856.SZ': ('ST 重组概念 • 游资高弹性脉冲', '[高位止盈]', 'rgba(239, 68, 68, 0.4)',
                  '在场 1,600 股单标的浮盈超 +10,500 元 (+50.3%)，一人平抑全部 ST 亏损；建议高位挂移动条件单分批止盈锁定暴利。'),
    '002883.SZ': ('ST 基础设施工程 • 浅套观察', '[微仓观察]', 'rgba(245, 158, 11, 0.4)',
                  '在场 1,300 股浅套 -14.2%，严禁盲目加仓，等待工程与重组题材右侧脉冲减亏。'),
    '002719.SZ': ('ST 食品乳业 • 风险警示震荡', '[死水静置]', 'rgba(239, 68, 68, 0.4)',
                  '在场 1,400 股深套 -38.5%，消费退潮与 ST 风险压制，坚决不加新钱，脉冲异动择机离场。'),
    '002193.SZ': ('ST 纺织服装 • 阴跌出清区', '[死水静置]', 'rgba(239, 68, 68, 0.4)',
                  '在场 2,200 股深套 -34.6%，死水无量阴跌，严格焊死仓位上限，耐心等待题材脉冲。'),
    '600822.SH': ('商业贸易与旧物资 • 历史老仓', '[微仓观察]', 'rgba(245, 158, 11, 0.4)',
                  '在场 800 股历史老仓浮亏 -36.7%，不追加资金，逢板块活跃择机减仓。'),
    '000623.SZ': ('医药健康与广发证券大股东', '[持仓观察]', 'rgba(59, 130, 246, 0.4)',
                  '在场 500 股浮亏 -8.3%，享 145 元现金分红；兼具中药与券商牛市影子股属性，安心持有。'),
    '600064.SH': ('区域园区综合开发 • 红利收息', '[红利底仓]', 'rgba(59, 130, 246, 0.4)',
                  '在场 1,100 股享有 352 元现金分红，抵扣分红实际仅微亏；高红利防守标的，持有收息。'),
    '000001.SZ': ('全国股份制零售银行 • 稳健分红', '[红利底仓]', 'rgba(16, 185, 129, 0.4)',
                  '在场 100 股浮盈 +10.7%，累计派息 60.9 元；低估值银行蓝筹，稳健收息。'),
    '600000.SH': ('全国股份制商业银行 • 破净修复', '[红利底仓]', 'rgba(16, 185, 129, 0.4)',
                  '在场 100 股浮盈 +3.3%，累计派息 42 元；深度破净国资银行，稳健防守。'),
    '300538.SZ': ('新材料工程塑料 • 残仓底仓观察', '[微仓观察]', 'rgba(245, 158, 11, 0.4)',
                  '在场仅 100 股（市值 1,350 元，成本 20.40 元）；持仓极小，静置观望，杜绝追加任何外部资金。'),
}


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

# Generate Target Cards HTML for all 38 symbols (sorted by market value DESC)
sorted_syms = sorted(
    [s for s in target_metrics.keys() if target_metrics[s]["shares"] > 0],
    key=lambda s: target_metrics[s]["market_value"],
    reverse=True
)

target_cards_html = []
target_js_data = {}

for sym in sorted_syms:
    m = target_metrics[sym]
    notes = SYMBOL_NOTES.get(sym, ('A 股赛道标的', '[持仓观察]', 'rgba(59, 130, 246, 0.4)', '依托底仓操盘，杜绝盲目左侧补仓。'))
    cat_tag, strat_tag, border_col, strat_desc = notes
    
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
    
    # T-trades stats
    if m['total_trades'] > 0:
        win_class = "val-green" if m['net_t_pnl'] >= 0 else "val-red"
        t_stats_str = f"{m['win_trades']}胜{m['loss_trades']}负 ({'+' if m['net_t_pnl'] >= 0 else ''}¥{m['net_t_pnl']:,.0f})"
    else:
        win_class = ""
        t_stats_str = "无平仓记录"
        
    # 盈亏比 (Profit/Loss Ratio)
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
        
    total_lots = m['total_lots_count']
    tot_cost = m['cost_unit'] * m['shares']
    mult_val = (m['market_value'] / tot_cost) if tot_cost > 0 else 1.0
    mult_class = "val-green" if mult_val >= 1.0 else "val-red"
    mult_str = f"{mult_val:.2f}x"
    
    # Physics formatting for Card
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
    
    card_badge_html = format_physics_badge_card(p)
    
    act_accs = set(l.get("account_id", "CMB") for l in act_lots)
    if "CMB" in act_accs and "PA" in act_accs:
        acc_badge = '<span class="tag tag-purple" style="font-size:10px;padding:1px 6px;">CMB + PA 双账户</span>'
        acc_filter_val = 'BOTH'
    elif "PA" in act_accs:
        acc_badge = '<span class="tag tag-amber" style="font-size:10px;padding:1px 6px;">PA 平安证券</span>'
        acc_filter_val = 'PA'
    else:
        acc_badge = '<span class="tag tag-blue" style="font-size:10px;padding:1px 6px;">CMB 招商证券</span>'
        acc_filter_val = 'CMB'

    # Build Card HTML
    card = f"""          <!-- Target Card: {m['name']} ({sym}) -->
          <div class="target-card" onclick="openTargetModal('{sym}')" data-account="{acc_filter_val}" data-brake-status="{brake_status}" data-rank-250="{p_rank250:.2f}" style="border-color: {border_col};">
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
              <div>现价: <strong>{curr_p_str}</strong></div>
              <div>市值: <strong>{mkt_val_str}</strong></div>
              <div>浮动盈亏: <strong class="{fpnl_class}">{fpnl_str}</strong></div>
              <div>持仓盈亏率: <strong class="{rr_class}">{rr_str}</strong></div>
              <div>本息倍数: <strong class="{mult_class}">{mult_str}</strong></div>
              <div>做T战绩: <strong class="{win_class}">{t_stats_str}</strong></div>
            </div>
            <div style="font-size: 12px; color: #cbd5e1; line-height: 1.5;">
              • <strong>操盘策略</strong>：{strat_desc}
            </div>
            <div class="target-card-hint">
              👆 点击穿透查看 {total_lots} 笔批次明细 (按买入时间排序) →
            </div>
          </div>"""
    target_cards_html.append(card)
    
    # Store for client-side JS Modal
    target_js_data[sym] = {
        "symbol": sym,
        "name": m['name'],
        "asset_class": m['asset_class'],
        "category": cat_tag,
        "qty_unit": m['qty_unit'],
        "shares": m['shares'],
        "cost_unit": m['cost_unit'],
        "current_price": m['current_price'],
        "market_value": m['market_value'],
        "floating_pnl": m['floating_pnl'],
        "return_rate": m['return_rate'],
        "total_trades": m['total_trades'],
        "win_trades": m['win_trades'],
        "loss_trades": m['loss_trades'],
        "win_rate": m['win_rate'],
        "net_t_pnl": m['net_t_pnl'],
        "profit_factor": m['profit_factor'],
        "profit_factor_str": m['profit_factor_str'],
        "avg_win_loss_str": m['avg_win_loss_str'],
        "dividends": m['dividends'],
        "total_withdrawn": m['total_withdrawn'],
        "strategy": strat_desc,
        "physics": physics_by_sym.get(sym),
        "lots": all_lots_by_sym.get(sym, [])
    }

target_cards_block = "\n\n".join(target_cards_html)

# Generate Tab: 38 Active Holdings table rows (sorted by return_rate DESC)
total_active_mkt = sum(target_metrics[s]["market_value"] for s in sorted_syms)
holdings_active_syms = sorted(
    sorted_syms,
    key=lambda s: target_metrics[s]["return_rate"],
    reverse=True
)

rows_holdings_html = []
for idx, sym in enumerate(holdings_active_syms, 1):
    m = target_metrics[sym]
    name = m["name"]
    notes = SYMBOL_NOTES.get(sym, ('A 股赛道标的', '[持仓观察]', 'rgba(59, 130, 246, 0.4)', '依托底仓操盘，杜绝盲目左侧补仓。'))
    cat_tag, strat_tag, border_col, strat_desc = notes
    
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
    rr_str = f"{"+" if rr > 0 else ""}{rr*100:.2f}%"
    
    mult = (mkt_val / tot_cost) if tot_cost > 0 else 1.0
    mult_class = "val-green" if mult >= 1.0 else "val-red"
    mult_str = f"{mult:.2f}x"
    
    weight = (mkt_val / total_active_mkt * 100) if total_active_mkt > 0 else 0
    weight_str = f"{weight:.2f}%"
    
    p_row = physics_by_sym.get(sym) or {}
    badge_table = format_physics_badge_table(p_row)
    rank250_val = p_row.get("pct_rank_250", 50.0)
    rank250_cls = "val-green" if rank250_val <= 20 else ("val-purple" if rank250_val >= 80 else "")

    act_accs = set(l.get("account_id", "CMB") for l in act_lots)
    if "CMB" in act_accs and "PA" in act_accs:
        tbl_acc_badge = '<span class="tag tag-purple" style="font-size:10px;padding:1px 6px;">CMB+PA</span>'
        tbl_acc_val = 'BOTH'
    elif "PA" in act_accs:
        tbl_acc_badge = '<span class="tag tag-amber" style="font-size:10px;padding:1px 6px;">PA</span>'
        tbl_acc_val = 'PA'
    else:
        tbl_acc_badge = '<span class="tag tag-blue" style="font-size:10px;padding:1px 6px;">CMB</span>'
        tbl_acc_val = 'CMB'

    row = f'''              <tr data-symbol="{sym}" data-account="{tbl_acc_val}" data-pnl-rate="{rr}" data-pnl-val="{fpnl}" data-mkt-val="{mkt_val}" data-cost-val="{tot_cost}" data-rank-250="{rank250_val:.2f}">
                <td class="rank-cell">{idx}</td>
                <td>{tbl_acc_badge}</td>
                <td><code>{sym}</code></td>
                <td><strong>{name}</strong></td>
                <td><span class="tag tag-green">{cat_tag}</span></td>
                <td>{qty_str}</td>
                <td>{cost_str}</td>
                <td>{curr_p_str}</td>
                <td>{tot_cost_str}</td>
                <td><strong>{mkt_val_str}</strong></td>
                <td><strong class="{fpnl_class}">{fpnl_str}</strong></td>
                <td><strong class="{rr_class}">{rr_str}</strong></td>
                <td><strong class="{mult_class}">{mult_str}</strong></td>
                <td>{weight_str}</td>
                <td>{badge_table}</td>
                <td><strong class="{rank250_cls}">{rank250_val:.1f}%</strong></td>
                <td><span class="tag tag-blue">{strat_tag}</span></td>
                <td><button class="subview-btn" style="padding:2px 8px;font-size:11px;" onclick="openTargetModal('{sym}')">🎯 穿透明细</button></td>
              </tr>'''
    rows_holdings_html.append(row)

tbody_holdings = chr(10).join(rows_holdings_html)


# Generate Tab 3 Active lots rows (188 active lots)
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

    lot_acc = lot.get("account_id", "CMB")
    rows_time_html.append(f"""              <tr data-symbol="{sym}" data-account="{lot_acc}">
      <td class="rank-cell">{idx}</td>
      <td><span class="tag tag-blue" style="font-size:10px;padding:1px 6px;">{lot.get("account_id", "CMB")}</span></td>
      <td><strong>{name}</strong> <span style="color:#94a3b8;font-size:11px;">({sym})</span></td>
      <td><code>{lot_id}</code></td>
      <td>{buy_date}</td>
      <td>{buy_p}</td>
      <td>{curr_p}</td>
      <td>{qty_str}</td>
      <td><strong class="{pnl_class}">{pnl_str}</strong></td>
      <td><strong class="{rr_class}">{rr_str}</strong></td>
      <td>{strat}</td>
    </tr>""")

tbody_time = "\n".join(rows_time_html)

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

    lot_acc = lot.get("account_id", "CMB")
    rows_pnl_html.append(f"""              <tr data-symbol="{sym}" data-account="{lot_acc}" data-return="{rr}">
      <td class="rank-cell">{idx}</td>
      <td><span class="tag tag-blue" style="font-size:10px;padding:1px 6px;">{lot.get("account_id", "CMB")}</span></td>
      <td><strong>{name}</strong> <span style="color:#94a3b8;font-size:11px;">({sym})</span></td>
      <td><code>{lot_id}</code></td>
      <td>{buy_date}</td>
      <td>{buy_p}</td>
      <td>{curr_p}</td>
      <td>{qty_str}</td>
      <td><strong class="{pnl_class}">{pnl_str}</strong></td>
      <td><strong class="{rr_class}">{rr_str}</strong></td>
      <td>{strat}</td>
    </tr>""")

tbody_pnl = "\n".join(rows_pnl_html)

# Generate Tab 4 Closed Trades rows (704 trades)
rows_trades_html = []
for idx, tr in enumerate(closed_trades_raw, 1):
    tr_id, name, sym, buy_time, buy_p, exec_time, sell_p, qty, pnl, action, tr_acc = tr
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

    trade_acc = tr_acc or "CMB"
    rows_trades_html.append(f"""              <tr data-symbol="{sym}" data-account="{trade_acc}">
      <td>{idx}</td>
      <td><span class="tag tag-blue" style="font-size:10px;padding:1px 6px;">{tr_acc or "CMB"}</span></td>
      <td><strong>{name}</strong> <span style="color:#94a3b8;font-size:11px;">({sym})</span></td>
      <td>{buy_d} ({p_buy_fmt})</td>
      <td>{sell_d} ({p_sell_fmt})</td>
      <td>{qty_str}</td>
      <td><strong class="{pnl_class}">{pnl_str}</strong></td>
      <td><strong class="{rr_class}">{rr_str}</strong></td>
      <td>{tag}</td>
    </tr>""")

tbody_trades = "\n".join(rows_trades_html)

# Symbol select options for Tab 3 filter
symbol_options = [f'<option value="ALL">全部 {len(sorted_syms)} 大标的 ({len(lots_active_data)} 笔在场活跃批次)</option>']
for s in sorted_syms:
    m = target_metrics[s]
    symbol_options.append(f'<option value="{s}">{m["name"]} ({s}) - {m["active_lots_count"]} 笔活跃批次</option>')
symbol_select_options_html = "\n".join(symbol_options)

# Convert target_js_data to JSON string for client-side embedding
target_js_json = json.dumps(target_js_data, ensure_ascii=False)

print("HTML Components prepared. Assembling full page...")

# Assemble the HTML template
with open(template_path, "r", encoding="utf-8") as tf:
    html_template = tf.read()

# Dynamic KPI calculations for interpolation
total_active_syms = len(sorted_syms)
total_active_lots = len(lots_active_data)

total_cost = sum(l['remaining_quantity'] * l['cost_basis_unit'] for l in lots_active_data)
total_mkt = sum(l['remaining_quantity'] * l['current_price'] for l in lots_active_data)
total_float_pnl = sum(l['floating_pnl'] for l in lots_active_data)

cmb_lots = [l for l in lots_active_data if l.get("account_id") == "CMB"]
pa_lots = [l for l in lots_active_data if l.get("account_id") == "PA"]

cmb_active_syms = len(set(l['symbol'] for l in cmb_lots))
pa_active_syms = len(set(l['symbol'] for l in pa_lots))
cmb_active_lots = len(cmb_lots)
pa_active_lots = len(pa_lots)

cmb_cost = sum(l['remaining_quantity'] * l['cost_basis_unit'] for l in cmb_lots)
cmb_mkt = sum(l['remaining_quantity'] * l['current_price'] for l in cmb_lots)
cmb_float_pnl = sum(l['floating_pnl'] for l in cmb_lots)

pa_cost = sum(l['remaining_quantity'] * l['cost_basis_unit'] for l in pa_lots)
pa_mkt = sum(l['remaining_quantity'] * l['current_price'] for l in pa_lots)
pa_float_pnl = sum(l['floating_pnl'] for l in pa_lots)

# Trades stats
total_closed_trades = len(closed_trades_raw)
total_win_trades = sum(1 for t in closed_trades_raw if t[8] > 0)
total_loss_trades = sum(1 for t in closed_trades_raw if t[8] < 0)
total_realized_pnl = sum(t[8] for t in closed_trades_raw)
win_rate = (total_win_trades / total_closed_trades * 100) if total_closed_trades > 0 else 0
win_pnl_sum = sum(t[8] for t in closed_trades_raw if t[8] > 0)
loss_pnl_sum = sum(abs(t[8]) for t in closed_trades_raw if t[8] < 0)
win_loss_ratio = (win_pnl_sum / loss_pnl_sum) if loss_pnl_sum > 0 else 999.0

# Dividends & Cash Withdrawn
total_divs = sum(DIVIDENDS_MAP.values())
total_withdrawn_cash = total_realized_pnl + total_divs

float_pnl_cls = "val-green" if total_float_pnl >= 0 else "val-red"
float_pnl_prefix = "+" if total_float_pnl > 0 else ""

html_content = html_template.replace("{{TARGET_CARDS_BLOCK}}", target_cards_block)
html_content = html_content.replace("{{TBODY_HOLDINGS}}", tbody_holdings)
html_content = html_content.replace("{{TBODY_TIME}}", tbody_time)
html_content = html_content.replace("{{TBODY_PNL}}", tbody_pnl)
html_content = html_content.replace("{{TBODY_TRADES}}", tbody_trades)
html_content = html_content.replace("{{SYMBOL_OPTIONS}}", symbol_select_options_html)
html_content = html_content.replace("{{TARGET_JS_JSON}}", target_js_json)

# Dynamic Placeholders
html_content = html_content.replace("{{TOTAL_ACTIVE_SYMBOLS_COUNT}}", str(total_active_syms))
html_content = html_content.replace("{{TOTAL_ACTIVE_LOTS_COUNT}}", str(total_active_lots))
html_content = html_content.replace("{{TOTAL_CLOSED_TRADES_COUNT}}", str(total_closed_trades))
html_content = html_content.replace("{{TOTAL_WIN_TRADES_COUNT}}", str(total_win_trades))
html_content = html_content.replace("{{TOTAL_LOSS_TRADES_COUNT}}", str(total_loss_trades))
html_content = html_content.replace("{{TOTAL_WIN_RATE_STR}}", f"{win_rate:.2f}%")
html_content = html_content.replace("{{TOTAL_WIN_LOSS_RATIO}}", f"{win_loss_ratio:.2f}")

html_content = html_content.replace("{{COMBINED_TOTAL_MKT_STR}}", f"¥{total_mkt/10000:.2f} 万")
html_content = html_content.replace("{{COMBINED_TOTAL_COST_STR}}", f"¥{total_cost:,.2f}")
float_pnl_pct = (total_float_pnl / total_cost * 100) if total_cost > 0 else 0.0
html_content = html_content.replace("{{COMBINED_TOTAL_FLOAT_PNL_STR}}", f"{float_pnl_prefix}¥{total_float_pnl:,.2f} ({float_pnl_pct:.2f}%)")
html_content = html_content.replace("{{COMBINED_TOTAL_FLOAT_PNL_CLS}}", float_pnl_cls)

html_content = html_content.replace("{{TOTAL_REALIZED_PNL_STR}}", f"+¥{total_realized_pnl:,.2f}")
html_content = html_content.replace("{{TOTAL_DIVIDENDS_STR}}", f"+¥{total_divs:,.2f}")
html_content = html_content.replace("{{TOTAL_WITHDRAWN_CASH_STR}}", f"+¥{total_withdrawn_cash:,.2f}")

html_content = html_content.replace("{{CMB_ACTIVE_SYMBOLS_COUNT}}", str(cmb_active_syms))
html_content = html_content.replace("{{CMB_ACTIVE_LOTS_COUNT}}", str(cmb_active_lots))
html_content = html_content.replace("{{CMB_COST_STR}}", f"¥{cmb_cost:,.2f}")
html_content = html_content.replace("{{CMB_MKT_STR}}", f"¥{cmb_mkt:,.2f}")
html_content = html_content.replace("{{CMB_MKT_W_STR}}", f"{cmb_mkt/10000:.1f} 万")

html_content = html_content.replace("{{PA_ACTIVE_SYMBOLS_COUNT}}", str(pa_active_syms))
html_content = html_content.replace("{{PA_ACTIVE_LOTS_COUNT}}", str(pa_active_lots))
html_content = html_content.replace("{{PA_COST_STR}}", f"¥{pa_cost:,.2f}")
html_content = html_content.replace("{{PA_MKT_STR}}", f"¥{pa_mkt:,.2f}")
html_content = html_content.replace("{{PA_MKT_W_STR}}", f"{pa_mkt/10000:.1f} 万")

out_path = os.path.abspath(args.out)
with open(out_path, "w", encoding="utf-8") as f:
    f.write(html_content)

print(f"Global dashboard successfully generated: {out_path} (Size: {os.path.getsize(out_path):,} bytes)")



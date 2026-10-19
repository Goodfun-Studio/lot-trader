"""Command line interface for Lot Trader (Executable: trade)."""
import argparse
from datetime import datetime
from decimal import Decimal
import json
import sys
from typing import List, Optional

from lot_trader.db import Database
from lot_trader.engine import TraderEngine
from lot_trader.quotes import QuoteProvider


def format_currency(val: float or Decimal) -> str:
    return f"{float(val):,.2f}"


def format_rate(rate: float or Decimal) -> str:
    r = float(rate) * 100
    if r > 0:
        return f"+{r:.2f}%"
    return f"{r:.2f}%"


def cmd_lot_buy(engine: TraderEngine, args: argparse.Namespace) -> None:
    try:
        buy_time = datetime.fromisoformat(args.time) if args.time else None
        fee = Decimal(str(args.fee)) if args.fee is not None else None
        price = Decimal(str(args.price))
        qty = int(args.qty)

        lot = engine.buy_lot(
            symbol_input=args.symbol,
            price=price,
            quantity=qty,
            fee=fee,
            buy_time=buy_time,
            parent_lot_id=args.parent
        )

        if args.json:
            out = {
                "code": 0,
                "msg": "success",
                "timestamp": datetime.now().isoformat(),
                "data": {
                    "lot_id": lot.lot_id,
                    "symbol": lot.symbol,
                    "buy_time": lot.buy_time.isoformat(),
                    "buy_price": float(lot.buy_price),
                    "buy_quantity": lot.buy_quantity,
                    "cost_basis_unit": float(lot.cost_basis_unit),
                    "buy_fee": float(lot.buy_fee),
                    "status": lot.status.value,
                    "pyramid_level": lot.pyramid_level,
                    "can_sell_now": lot.can_sell_now
                }
            }
            print(json.dumps(out, ensure_ascii=False, indent=2))
        else:
            print(f"✅ 成功录入买入批次: {lot.lot_id}")
            print(f"标的代码: {lot.symbol} | 数量: {lot.buy_quantity} | 成交单价: {lot.buy_price:.4f} 元")
            print(f"全成本单价: {lot.cost_basis_unit:.4f} 元 | 规费: {lot.buy_fee:.2f} 元 | 即刻可卖: {lot.can_sell_now}")
            if lot.parent_lot_id:
                print(f"溯源父批次: {lot.parent_lot_id} (加仓层级 L{lot.pyramid_level})")

    except Exception as e:
        if getattr(args, "json", False):
            print(json.dumps({"code": 1, "msg": str(e), "data": None}, ensure_ascii=False))
        else:
            print(f"❌ 建仓失败: {e}", file=sys.stderr)
        sys.exit(1)


def cmd_lot_list(engine: TraderEngine, args: argparse.Namespace) -> None:
    try:
        lots = engine.list_lots(status=args.status, symbol=args.symbol)

        if args.json:
            out = {
                "code": 0,
                "msg": "success",
                "timestamp": datetime.now().isoformat(),
                "data": lots
            }
            print(json.dumps(out, ensure_ascii=False, indent=2))
        else:
            if not lots:
                print(f"暂无符合条件的批次数据 (status={args.status}, symbol={args.symbol})")
                return

            header = f"{'Lot ID':<19} | {'Symbol':<10} | {'Name':<8} | {'Qty':>6} | {'BuyCost':>8} | {'Current':>8} | {'Return':>9} | {'PnL':>10} | {'Action Advice':<14}"
            sep = "-" * len(header)
            print(sep)
            print(header)
            print(sep)

            for l in lots:
                r_rate = l["return_rate"]
                if r_rate >= 0.10:
                    advice = "[可止盈]"
                elif r_rate <= -0.20:
                    advice = "[深跌击球]"
                elif r_rate <= -0.10:
                    advice = f"[可加仓{l['pyramid_level']+1}]"
                else:
                    advice = "[持仓观察]"

                b_cost_str = f"{l['cost_basis_unit']:.3f}"
                curr_str = f"{l['current_price']:.3f}"
                pnl_str = f"{l['floating_pnl']:+,.2f}"

                print(
                    f"{l['lot_id']:<19} | {l['symbol']:<10} | {l['symbol_name'][:6]:<8} | "
                    f"{l['remaining_quantity']:>6} | {b_cost_str:>8} | {curr_str:>8} | "
                    f"{format_rate(r_rate):>9} | {pnl_str:>10} | {advice:<14}"
                )
            print(sep)
    except Exception as e:
        if getattr(args, "json", False):
            print(json.dumps({"code": 1, "msg": str(e), "data": None}, ensure_ascii=False))
        else:
            print(f"❌ 查询批次失败: {e}", file=sys.stderr)
        sys.exit(1)


def cmd_scan(engine: TraderEngine, args: argparse.Namespace) -> None:
    try:
        thresholds = None
        if args.thresholds:
            raw_t = json.loads(args.thresholds)
            thresholds = {k: Decimal(str(v)) for k, v in raw_t.items()}

        signals = engine.scan_signals(custom_thresholds=thresholds)

        if args.json:
            sig_list = []
            for s in signals:
                payload = json.loads(s.payload_json) if s.payload_json else {}
                sig_list.append({
                    "signal_id": s.signal_id,
                    "signal_type": s.signal_type.value,
                    "lot_id": s.lot_id,
                    "symbol": s.symbol,
                    "trigger_return_rate": float(s.trigger_return_rate),
                    "trigger_price": float(s.trigger_price),
                    "suggested_action": s.suggested_action,
                    "payload": payload
                })
            out = {
                "code": 0,
                "msg": "success",
                "timestamp": datetime.now().isoformat(),
                "data": {
                    "total_signals": len(sig_list),
                    "signals": sig_list
                }
            }
            print(json.dumps(out, ensure_ascii=False, indent=2))
        else:
            if not signals:
                print("✨ 扫描完成：当前所有活跃批次运行正常，未触及加仓或止盈阈值。")
                return

            print(f"🎯 盘中扫描完成，共捕获 {len(signals)} 条策略建议信号：")
            print("=" * 80)
            for s in signals:
                payload = json.loads(s.payload_json) if s.payload_json else {}
                print(f"【{s.signal_type.value}】标的: {s.symbol} | 批次: {s.lot_id}")
                print(f"当前价格: {s.trigger_price:.4f} | 收益率: {format_rate(s.trigger_return_rate)}")
                print(f"建议动作: {s.suggested_action}")
                if "reason" in payload:
                    print(f"决策依据: {payload['reason']}")
                if "est_profit" in payload:
                    print(f"预期收益: +{payload['est_profit']:,.2f} 元")
                print("-" * 80)
    except Exception as e:
        if getattr(args, "json", False):
            print(json.dumps({"code": 1, "msg": str(e), "data": None}, ensure_ascii=False))
        else:
            print(f"❌ 扫描信号失败: {e}", file=sys.stderr)
        sys.exit(1)


def cmd_lot_close(engine: TraderEngine, args: argparse.Namespace) -> None:
    try:
        price = Decimal(str(args.price))
        qty = int(args.qty) if args.qty is not None else None
        fee = Decimal(str(args.fee)) if args.fee is not None else None

        updated_lot, trade = engine.close_lot(
            lot_id=args.lot_id,
            close_price=price,
            close_quantity=qty,
            substitute_core=args.substitute_core,
            fee=fee
        )

        if args.json:
            out = {
                "code": 0,
                "msg": "success",
                "timestamp": datetime.now().isoformat(),
                "data": {
                    "lot_id": updated_lot.lot_id,
                    "trade_id": trade.trade_id,
                    "action": trade.action.value,
                    "close_price": float(trade.price),
                    "close_quantity": trade.quantity,
                    "fee": float(trade.fee),
                    "realized_pnl": float(trade.realized_pnl),
                    "remaining_quantity": updated_lot.remaining_quantity,
                    "lot_status": updated_lot.status.value,
                    "is_day_trading": updated_lot.is_day_trading,
                    "substituted_core_lot_id": updated_lot.substituted_core_lot_id
                }
            }
            print(json.dumps(out, ensure_ascii=False, indent=2))
        else:
            print(f"🎉 批次平仓操作成功！流水号: {trade.trade_id}")
            print(f"批次ID: {updated_lot.lot_id} | 状态: {updated_lot.status.value}")
            print(f"平仓成交价: {trade.price:.4f} 元 | 平仓股数: {trade.quantity} 股 | 规费: {trade.fee:.2f} 元")
            print(f"本次实现净利润: {trade.realized_pnl:+,.2f} 元")
            if updated_lot.is_day_trading:
                print(f"⚡ [日内等效T+0回转达成] 代冲底仓: {updated_lot.substituted_core_lot_id or '天然T+0回转'}")
            if updated_lot.remaining_quantity > 0:
                print(f"剩余持仓股数: {updated_lot.remaining_quantity} 股 (状态保持 ACTIVE 继续监控)")

    except Exception as e:
        if getattr(args, "json", False):
            print(json.dumps({"code": 1, "msg": str(e), "data": None}, ensure_ascii=False))
        else:
            print(f"❌ 平仓失败: {e}", file=sys.stderr)
        sys.exit(1)


def cmd_stats(engine: TraderEngine, args: argparse.Namespace) -> None:
    try:
        stats = engine.compute_stats(days=args.days, symbol=args.symbol)

        if args.json:
            out = {
                "code": 0,
                "msg": "success",
                "timestamp": datetime.now().isoformat(),
                "data": stats
            }
            print(json.dumps(out, ensure_ascii=False, indent=2))
        else:
            print("📊 操盘战绩统计报表")
            print("=" * 45)
            print(f"总平仓笔数: {stats['total_trades']:>6} 笔")
            print(f"盈利笔数  : {stats['winning_trades']:>6} 笔")
            print(f"亏损笔数  : {stats['losing_trades']:>6} 笔")
            print(f"综合胜率  : {stats['win_rate'] * 100:>6.2f} %")
            print(f"累计净利润: {stats['total_realized_pnl']:>+12,.2f} 元")
            print(f"盈亏比    : {stats['profit_factor']:>6.2f}")
            print(f"日内做T笔数: {stats['day_trades_count']:>5} 笔")
            print("=" * 45)

    except Exception as e:
        if getattr(args, "json", False):
            print(json.dumps({"code": 1, "msg": str(e), "data": None}, ensure_ascii=False))
        else:
            print(f"❌ 统计战绩失败: {e}", file=sys.stderr)
        sys.exit(1)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="trade",
        description="Lot Trader Core CLI Engine (Unix Way & Hexagonal Architecture)"
    )
    subparsers = parser.add_subparsers(dest="command", help="Available subcommands")

    # trade lot ...
    lot_parser = subparsers.add_parser("lot", help="Lot operations")
    lot_subparsers = lot_parser.add_subparsers(dest="lot_command", help="Lot actions")

    # trade lot buy
    buy_p = lot_subparsers.add_parser("buy", help="Buy / create a new lot")
    buy_p.add_argument("--symbol", required=True, help="Symbol code or name (e.g. 518880.SH)")
    buy_p.add_argument("--price", required=True, type=float, help="Buy price")
    buy_p.add_argument("--qty", required=True, type=int, help="Buy quantity (multiple of 100)")
    buy_p.add_argument("--fee", type=float, default=None, help="Buy fee")
    buy_p.add_argument("--time", type=str, default=None, help="Buy timestamp ISO format")
    buy_p.add_argument("--parent", type=str, default=None, help="Parent lot ID for dip accumulation")
    buy_p.add_argument("--json", action="store_true", help="Output JSON stream")

    # trade lot list
    list_p = lot_subparsers.add_parser("list", help="List lots")
    list_p.add_argument("--status", type=str, default="ACTIVE", choices=["ACTIVE", "CLOSING", "CLOSED", "ALL"], help="Filter by status (default ACTIVE)")
    list_p.add_argument("--symbol", type=str, default=None, help="Filter by symbol")
    list_p.add_argument("--json", action="store_true", help="Output JSON stream")

    # trade lot close
    close_p = lot_subparsers.add_parser("close", help="Close a lot")
    close_p.add_argument("--lot-id", required=True, help="Target lot ID to close")
    close_p.add_argument("--price", required=True, type=float, help="Closing execution price")
    close_p.add_argument("--qty", type=int, default=None, help="Closing quantity (default all)")
    close_p.add_argument("--substitute-core", action="store_true", help="Substitute core position for T+0 day trade")
    close_p.add_argument("--fee", type=float, default=None, help="Closing fee")
    close_p.add_argument("--json", action="store_true", help="Output JSON stream")

    # trade scan
    scan_p = subparsers.add_parser("scan", help="Scan active lots for signals")
    scan_p.add_argument("--thresholds", type=str, default=None, help="Custom thresholds JSON")
    scan_p.add_argument("--json", action="store_true", help="Output JSON stream")

    # trade stats
    stats_p = subparsers.add_parser("stats", help="Performance statistics")
    stats_p.add_argument("--days", type=int, default=None, help="Stats within recent N days")
    stats_p.add_argument("--symbol", type=str, default=None, help="Filter by symbol")
    stats_p.add_argument("--json", action="store_true", help="Output JSON stream")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    # Initialize db and engine
    db = Database()
    engine = TraderEngine(db.get_connection())

    if args.command == "lot":
        if args.lot_command == "buy":
            cmd_lot_buy(engine, args)
        elif args.lot_command == "list":
            cmd_lot_list(engine, args)
        elif args.lot_command == "close":
            cmd_lot_close(engine, args)
        else:
            parser.print_help()
    elif args.command == "scan":
        cmd_scan(engine, args)
    elif args.command == "stats":
        cmd_stats(engine, args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()


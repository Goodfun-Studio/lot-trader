"""Tests for CLI subcommands."""
import json
import subprocess
import sys
import pytest
from pathlib import Path


def run_trade_cli(args, env_db):
    repo_root = Path(__file__).parent.parent
    cmd = [sys.executable, "-m", "lot_trader.cli"] + args
    env = {
        "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
        "PYTHONPATH": str(repo_root / "src"),
        "LOT_TRADER_DB": str(env_db)
    }
    p = subprocess.run(cmd, capture_output=True, text=True, env=env)
    return p


def test_cli_lot_lifecycle(tmp_path):
    db_file = tmp_path / "cli_test.db"

    # 1. Buy Gold ETF via CLI
    p1 = run_trade_cli(["lot", "buy", "--symbol", "518880.SH", "--price", "6.12", "--qty", "2000", "--json"], db_file)
    assert p1.returncode == 0
    res1 = json.loads(p1.stdout)
    assert res1["code"] == 0
    lot_id = res1["data"]["lot_id"]
    assert lot_id.startswith("LOT-")

    # 2. List lots via CLI
    p2 = run_trade_cli(["lot", "list", "--json"], db_file)
    assert p2.returncode == 0
    res2 = json.loads(p2.stdout)
    assert len(res2["data"]) == 1
    assert res2["data"][0]["lot_id"] == lot_id

    # 3. List lots in table mode
    p2_table = run_trade_cli(["lot", "list"], db_file)
    assert p2_table.returncode == 0
    assert "518880.SH" in p2_table.stdout

    # 4. Scan signals
    p3 = run_trade_cli(["scan", "--json"], db_file)
    assert p3.returncode == 0
    res3 = json.loads(p3.stdout)
    assert "signals" in res3["data"]

    # 5. Close lot via CLI
    p4 = run_trade_cli(["lot", "close", "--lot-id", lot_id, "--price", "7.05", "--json"], db_file)
    assert p4.returncode == 0
    res4 = json.loads(p4.stdout)
    assert res4["code"] == 0
    assert res4["data"]["lot_status"] == "CLOSED"
    assert res4["data"]["realized_pnl"] > 1800

    # 6. Check stats via CLI
    p5 = run_trade_cli(["stats", "--json"], db_file)
    assert p5.returncode == 0
    res5 = json.loads(p5.stdout)
    assert res5["data"]["total_trades"] == 1
    assert res5["data"]["winning_trades"] == 1
    assert res5["data"]["win_rate"] == 1.0

    # 7. Check stats in ASCII table mode
    p5_table = run_trade_cli(["stats"], db_file)
    assert p5_table.returncode == 0
    assert "操盘战绩统计报表" in p5_table.stdout


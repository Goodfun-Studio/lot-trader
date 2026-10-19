# lot-trader

单笔批次独立盈亏监控与加仓止盈操盘核心引擎 (Phase 1: Core CLI & Testing Suite)。

## 架构特性
- **纯粹 Core CLI 引擎**：遵循 Unix 哲学与六边形架构，专注于资产建账、逐批盈亏核算、天然 T+0 与底仓代冲做 T 仲裁、加仓与止盈信号扫描、平仓结转。
- **本地 SQLite 持久化**：零云端泄漏，纯本地自持。
- **天然 T+0 与底仓代冲**：自动识别黄金 ETF 等天然 T+0 品种与法定 T+1 标的日内代冲做 T。
- **深跌击球区防御**：跌幅超过 -20% 严禁冻结，保持 ACTIVE 活跃监控并出具 `DEEP_VALUE_ALERT`。

## 快速使用
```bash
# 激活环境或直接调用
python3 -m lot_trader.cli lot buy --symbol 518880.SH --price 6.120 --qty 2000
python3 -m lot_trader.cli lot list
python3 -m lot_trader.cli scan
python3 -m lot_trader.cli lot close --lot-id LOT-xxxx --price 7.050
python3 -m lot_trader.cli stats
```


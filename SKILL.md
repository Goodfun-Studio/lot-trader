---
name: lot-trader
description: 投资操盘与单笔批次盈亏监控工具 (lot-trader)。当用户提到买入股票/ETF/黄金、建仓记录、查看持仓批次、盘中扫描加仓止盈信号、梯级补仓、指定批次平仓做T、或复盘操盘战绩时使用此技能。直接通过 Bash 调用本地 trade 命令行工具执行。
description: 投资操盘与单笔批次盈亏监控工具 (lot-trader)。当用户提到买入股票/ETF/黄金、建仓记录、查看标的持仓聚合全景视图(position/holding)、查看持仓批次、盘中扫描加仓止盈信号、梯级补仓、指定批次平仓做T、或复盘操盘战绩时使用此技能。直接通过 Bash 调用本地 trade 命令行工具执行。
---

# 投资操盘工具 (lot-trader) 使用指南

本机已全局安装独立操盘引擎 `trade`（位于 `/Users/ivywu/.local/bin/trade`），数据完全自持在本地 SQLite 数据库（`~/.trade/trade.db`）。

所有智能体调用时，**必须统一附加 `--json` 参数**，以获得稳定可解析的结构化返回。

---

## 1. 核心业务原则

1. **单笔批次独立监控 (Lot-based)**：每次买入生成独立的 Lot 实例。不采用加权平均成本法摊薄，针对每一笔买入独立核算保本单价、实时现价与浮动收益率。
2. **严禁深跌冻结 (Active Deep Value)**：单笔浮亏超过 -20% 属于深度击球区，保持 `ACTIVE` 监控状态，出具 `DEEP_VALUE_ALERT` 企稳加仓建议，严禁将批次锁死。
3. **加仓防抖守卫 (Anti-shake Guard)**：同一父批次 48 小时（2 个交易日）内仅允许加仓一次，防止急跌连续补仓过快耗尽流动性。
4. **单标的 30% 仓位硬顶**：单标的总持仓市值在整个组合中占比超过 30% 时，系统强制拦截加仓并出具风控预警。
5. **交易机制解耦**：
   - 黄金 ETF (`518880.SH`, `159934.SZ` 等)：制度性天然 T+0，买入当日盈利可即刻平仓锁定利润；
   - 普通股票/行业 ETF：法定 T+1。若账户内持有昨日及以前交收的可用底仓，可使用底仓代冲完成日内等效 T+0 平仓锁定波段利润；首日无底仓时强拦截裸卖空。

---

## 2. 智能体命令速查

### 买入建仓
```bash
trade lot buy --symbol <代码> --price <成交单价> --qty <股数, 需整百> --json
```
- 代码支持简写（如 `518880` 自动补全为 `518880.SH`，`600519` 补全为 `600519.SH`，`000001` 补全为 `000001.SZ`）。
- 成功返回包含 `lot_id`、`cost_basis_unit`（含规费全成本）与 `can_sell_now`。

### 梯级加仓
```bash
trade lot add --parent-lot-id <父批次ID> --price <成交单价> [--amount 10000] --json
```
- 自动绑定父子血缘关系并递增加仓层级（L1 ➔ L2 ➔ L3）。
- 自动触发 48 小时防抖冷却与 30% 单标的仓位上限校验。

### 查看三层深层聚合持仓视图 (Position / Holding View)
```bash
trade position [--symbol <代码>] [--cap <单标满仓额, 默认50000>] --json
```
- 深度对齐 InvestmentTracker 源码的三层全景持仓架构：
  1. **Layer 1: 组合总览卡头 (Portfolio Summary)**：
     - `total_cost`（组合总持仓成本）、`total_market_value`（总市值）；
     - `full_position_cap`（单标满仓额度，默认 50,000 元）；
     - `total_floating_pnl`（总浮动盈亏额）、`overall_return_rate`（总收益率）；
     - `total_active_lots`（活跃批次数）、`total_symbols_count`（持仓标的数）。
  2. **Layer 2: 标的汇总与双重仓位 (Symbol Summary)**：
     - `cost_position_rate`：**成本仓位占比**（标的总持仓成本 / 单标满仓额）；
     - `current_position_rate`：**当前市值仓位占比**（标的总市值 / 单标满仓额）；
     - `portfolio_weight`：标的市值占组合总市值百分比（匹配 30% 风控硬顶）；
     - `last_buy_price`：最近一笔买入价格；
     - `recommended_buy_in_point`（建议加仓区间：< 最近买入价 × 0.90）；
     - `recommended_sale_out_point`（建议止盈区间：> 最近买入价 × 1.10）；
     - `total_quantity`、`available_core_qty`、`avg_cost_price`、`total_floating_pnl` 等。
  3. **Layer 3: 标的下属批次逐笔内嵌展开 (Nested Lots Breakdown)**：
     - 标的内直接嵌套 `lots` 数组，每笔包含：批次ID、买入时间、成交价、保本全成本、数量、独立盈亏比、浮动盈亏、即刻可卖权限及操作建议。
- 直接执行 `trade position` 则输出层级分明、排版优雅的 ASCII 三层嵌套视图卡片。

### 查看所有持仓批次
```bash
trade lot list --status ACTIVE --json
```
- 返回包含实时现价（对接腾讯财经）、独立收益率、浮动盈亏以及当前操作建议。

### 盘中实时扫描操盘信号
```bash
trade scan --json
```
- 捕获三类信号：
  - `TAKE_PROFIT_ALERT`：浮盈达标（+10%~+20%），建议平仓止盈；
  - `TRAILING_STOP_ALERT`：浮盈触及 +15% 开启跟踪后，现价自历史最高点回撤 3%，触发移动止盈；
  - `ADD_POSITION_ALERT` / `DEEP_VALUE_ALERT`：浮亏触及加仓区间或深跌区，建议逢低企稳加仓。

### 指定批次平仓
```bash
trade lot close --lot-id <批次ID> --price <成交单价> [--qty <数量>] [--substitute-core] --json
```
- 支持全额平仓与部分平仓（指定 `--qty`）。
- 股票日内做 T 代冲平仓需追加 `--substitute-core`。

### 复盘战绩统计
```bash
trade stats --json
```
- 返回总平仓笔数、综合胜率、累计净利润、盈亏比，并附带按操盘类别（普通波段、天然 T+0、底仓做 T）与标的明细的多维归因。

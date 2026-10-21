---
name: lot-trader
description: 投资操盘与单笔批次盈亏监控工具 (lot-trader)。当用户提到买入股票/ETF/黄金、建仓记录、查看标的持仓聚合全景视图(position/holding)、查看持仓批次、盘中扫描加仓止盈信号、梯级补仓、指定批次平仓做T、或生成/更新全局交互式监控看板、或复盘操盘战绩时使用此技能。直接通过 Bash 调用本地 trade 命令行工具执行。
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
5. **多证券账户独立核算与底仓代冲强隔离**：
   - 支持多券商/多账户操盘（通过 `--account <ACC>` 标明，默认 `DEFAULT`）。账户元数据（别名、券商代码、币种、启用状态）落在 `accounts` 表，可用 `trade account list/add` 维护。
   - 法定 T+1 标的日内代冲做 T 绝不允许跨券商/账户冲抵，可用底仓严格限定在同一 `(symbol, account_id)` 空间内，严防挪用裸卖空！
   - 加仓（`lot add`）默认自动继承父批次账户，亦允许显式覆盖。
   - 未登记的 `--account` 在买入时自愈登记为 `CUSTOM` 券商，不阻断快捷录入。
6. **买卖决策理由沉淀 (Decision Thesis)**：`lots.buy_reason` 记录建仓/加仓假设，`lots.close_reason` 记录平仓终局复盘，`trades.reason` 记录单笔买卖动机；全部可选，缺省为 `NULL`，绝不阻断正常录入。
6. **交易机制解耦**：
   - 黄金 ETF (`518880.SH`, `159934.SZ` 等)：制度性天然 T+0，买入当日盈利可即刻平仓锁定利润；
   - 普通股票/行业 ETF：法定 T+1。若账户内持有昨日及以前交收的可用底仓，可使用底仓代冲完成日内等效 T+0 平仓锁定波段利润；首日无底仓时强拦截裸卖空。

---

## 2. 智能体命令速查

### 买入建仓
```bash
# 完整旗标式
trade lot buy --symbol <代码> --price <成交单价> --qty <股数, 需整百> [--account <账户代码>] [--reason "买入理由"] --json
# 位置参数速记
trade lot buy <代码> <成交单价> <股数> [--account <账户代码>] [--reason "买入理由"]
```
- 代码支持简写（如 `518880` 自动补全为 `518880.SH`，`600519` 补全为 `600519.SH`，`000001` 补全为 `000001.SZ`）。
- 成功返回包含 `lot_id`、`account_id`、`cost_basis_unit`（含规费全成本）、`can_sell_now` 与 `buy_reason`。
- `--reason` 可选；同时写入 `lots.buy_reason` 与对应 BUY 流水的 `trades.reason`。

### 梯级加仓
```bash
# 完整旗标式
trade lot add --parent-lot-id <父批次ID> --price <成交单价> [--amount 10000] [--qty <股数>] [--account <账户代码>] [--reason "加仓理由"] --json
# 位置参数速记
trade lot add <父批次ID> <成交单价> [--reason "加仓理由"]
```
- 自动绑定父子血缘关系并递增加仓层级（L1 ➔ L2 ➔ L3）。
- 默认自动继承父批次 `account_id`，亦可通过 `--account` 显式指定覆盖。
- 自动触发 48 小时防抖冷却与 30% 单标的仓位上限校验。
- `--reason` 记录本轮加仓的具体触发逻辑（写入新批次的 `buy_reason` 与 BUY 流水）。

### 券商账户注册与查询 (trade account)
```bash
trade account list [--all] [--json]
trade account add <account_id> --name <账户别名> [--broker <券商代码>] [--currency <ISO4217>] [--json]
```
- `--broker` 预设：`CMB` / `CITIC` / `HTSC` / `EASTMONEY` / `GUOTAI` / `YINHE` / `GF` / `PA` / `FUTU` / `IBKR` / `CUSTOM`（默认 `CUSTOM`）。
- `trade account list` 输出账户 ID、别名、券商代码、币种与启用状态；`--all` 包含已停用账户。
- 重复登记、空别名、非法券商代码/币种/账户 ID 均确定性报错；买入时传入未注册账户则自动自愈登记。

### 查看三层深层聚合持仓视图 (Position / Holding View)
```bash
trade position [--symbol <代码>] [--cap <单标满仓额, 默认50000>] [--account <账户代码>] --json
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
trade lot list [--status ACTIVE] [--symbol <代码>] [--account <账户代码>] --json
```
 - 表格与 JSON 输出包含所属账户（Account）、实时现价、独立收益率、浮动盈亏以及当前操作建议。

### 盘中实时扫描操盘信号
```bash
trade scan [--account <账户代码>] --json
```
- 捕获三类信号：
 - 信号输出标注【账户: ACC】，支持按账户隔离检索。
  - `TAKE_PROFIT_ALERT`：浮盈达标（+10%~+20%），建议平仓止盈；
  - `TRAILING_STOP_ALERT`：浮盈触及 +15% 开启跟踪后，现价自历史最高点回撤 3%，触发移动止盈；
  - `ADD_POSITION_ALERT` / `DEEP_VALUE_ALERT`：浮亏触及加仓区间或深跌区，建议逢低企稳加仓。

### 指定批次平仓
```bash
trade lot close --lot-id <批次ID> --price <成交单价> [--qty <数量>] [--account <账户代码>] [--substitute-core] [--reason "平仓理由"] --json
# 位置参数速记
trade lot close <批次ID> <成交单价> [数量] [--reason "平仓理由"]
```
- 支持全额平仓与部分平仓（指定 `--qty`）。
- 股票日内做 T 代冲平仓需追加 `--substitute-core`（严格限制在同一券商账户内的交收底仓代冲）。
- `--reason` 写入 `trades.reason` 并累积到 `lots.close_reason`（多次部分平仓按换行追加，不覆盖历史复盘）。

### 更新批次决策理由 (lot edit)
```bash
trade lot edit <批次ID> [--reason "更新后的买入理由"] [--close-reason "更新后的平仓复盘"] [--append] --json
```
- 仅修改决策理由字段，绝不触碰价格、数量、成本与盈亏等会计字段。
- `--append` 追加而非覆盖；传空字符串则清空为 `NULL`。

### 标的物理运动量化雷达 (Physics Momentum Radar)
```bash
trade physics <代码> [--json]
# 或别名
trade radar <代码> [--json]
```
- 输出标的纯量化客观物理运动指标（腾讯财经前复权历史K线驱动）：
  - **动量速度 v (Velocity)**：5日短期动量斜率与20日中期动量斜率（归一化日均斜率百分比 v = (k / P_mean) * 100%）；
  - **动量加速度 a (Acceleration)**：短期速度变化率（a = v_short_current - v_short_prev），量化加速上涨、加速下坠或下坠刹车减速；
  - **惯性质量 m (Inertial Mass)**：当日成交量相对20日均量倍数（m = Vol_today / MA(Vol, 20)）；
  - **多空博弈净合力 F (Force)**：F = m * a，量化急跌天量下坠收敛的底部强承接托底（F > 0）或巨量滞涨上方抛压（F < 0）；
  - **博弈参与度 τ (Turnover Ratio)**：当日真实换手率百分比（腾讯行情第 38 项，如 0.27 表示 0.27%）；
  - **置信度加权有效合力 F_eff (Confidence-Weighted Effective Force)**：F_eff = F × W_conf，区分「无量假动作」与「放量真变盘」；
  - **流体阻尼系数 μ (Fluid Damping)**：单位价格振幅所消耗的成交量密度，量化盘口筹码承接的浓稠度；
  - **周期空间位置**：60日/250日价格分位数与距区间最高点回撤幅度。
- `trade position` 标的卡头下方自动呈现该标的物理动量走势核心摘要（含有效合力 F_eff 与置信等级）。

#### 置信度加权模型（无量虚火 vs 天量决战）

```
W_conf = clamp( W_abs(τ) × W_rel(γ), 0.10, 2.00 )
γ      = τ / τ̄20   （无历史换手率序列时以成交量倍数 m = Vol_today / MA20(Vol) 等价替代）
F_eff  = F × W_conf
```

- **W_abs(τ) 换手率绝对规模**（判断是否「地量」）：0.05%→0.22、0.10%→0.33、0.20%→0.45、0.40%→0.70、0.60%→0.84、1.00%→1.00、2.00%→1.12、3.00%→1.18、≥5.00%→1.25（分段线性插值，区间外端点饱和）；
- **W_rel(γ) 相对放量倍数**（判断是否「重兵对决」）：0.5x→0.75、0.8x→0.92、1.0x→1.00、1.5x→1.12、2.0x→1.22、3.0x→1.35、≥5.0x→1.45；
- **置信等级**：`LOW`（W_conf < 0.80，参与度不足，警惕无量虚火）/ `MEDIUM`（0.80 ≤ W_conf < 1.20，正常博弈中枢）/ `HIGH`（W_conf ≥ 1.20 且换手率证据可用，天量对决高确定性合力）；
- **负向防误杀守卫**：换手率 0 / 负数 / 缺失 / NaN 一律视为不可用（W_abs = 1.0，W_conf 封顶 1.20，等级绝不宣称 HIGH）；量能倍数异常时退回中性 1.0；任何路径均不产生 NaN 或除零，`effective_force` 恒为有限数值。
- 使用口径：**原始合力 F 不变**，仅派生 `effective_force`；LOW 等级下的强 F 应视为「待换手放大确认」的候选信号，不作为重仓依据。

### 复盘战绩统计
```bash
trade stats --json
```
- 返回总平仓笔数、综合胜率、累计净利润、盈亏比，并附带按操盘类别（普通波段、天然 T+0、底仓做 T）与标的明细的多维归因。

---

## 3. 看板与报表呈现规范 (Dashboard & Presentation Standard)

在构建全局监控看板（HTML Dashboard）或生成投顾复盘报表时，必须严格遵守以下呈现规范：

1. **在场活跃批次（Active Lots）多维视图完全分离原则**：
   - **严禁混维展示**：**“按买入时间排序”** 与 **“按盈亏率排序”** 属于两个目标截然不同的分析维度，**严禁混在一个列表中**，不能仅依靠表格临时排序列混淆默认心智。
   - **列表视图 1：时间维度视图 (Time-Ordered View)**：
     - 严格按买入时间倒序排列（最新交易在前，历史建仓在后）。
     - 核心定位：追踪资金进出轨迹、检验 48 小时加仓防抖执行情况、复盘近期击球时点。
   - **列表视图 2：盈亏率维度视图 (Return-Rate Ranked View)**：
     - 严格按批次浮动盈亏率排序（支持从正收益浮盈梯队、浅度回撤梯队到深度击球梯队、山顶冰川梯队的分层透视）。
     - 核心定位：识别正收益待止盈批次、评估标的下属批次风险暴露、定向挑选最深负收益批次进行底仓代冲对冲消融。
   - **交互形态要求**：在页面中必须提供明确的独立子切换卡（Sub-tabs / View Switcher），物理隔离两个表格视图，保证每个视图拥有独立的表头说明与统计视角。

---

## 4. 全局交互式监控看板 (Global Dashboard)

看板生成已作为 **CLI 原生原语** 集成进 `trade`，无需手工拼路径调 Python：

```bash
# 默认在当前目录生成 lot-trader-global-dashboard.html
trade dashboard

# 指定输出路径，并生成后自动用系统默认浏览器打开
trade dashboard --out /path/to/dashboard.html --open

# 智能体结构化调用口径
trade dashboard --json
```

### CLI 参数
- `--out, -o PATH`：输出 HTML 路径（默认 `./lot-trader-global-dashboard.html`）；
- `--open`：生成后调用系统默认浏览器打开（macOS `open` / Linux `xdg-open` / Windows `start`）；
- `--template, -t PATH`：前端模板路径（默认自动定位脚本同目录的 `template_base.html`）；
- `--db PATH`：SQLite 账本路径（默认 `$LOT_TRADER_DB` → `$TRADE_DB_PATH` → `~/.trade/trade.db`）；
- `--json`：输出 `{"code":0,"msg":"success","data":{out,script,template,db,bytes,opened}}`；失败时 `code=1` 并退出码 1。

### 资源定位与架构
- 资产固化在仓库 `scripts/` 目录：**主脚本** `scripts/generate_dashboard.py`、**前端模板** `scripts/template_base.html`；并同步到 `~/.claude`、`~/.codex`、`~/.agents` 三处 `skills/lot-trader/scripts/`。
- 查找顺序：`--scripts-dir` → `$LOT_TRADER_SCRIPTS_DIR` → 可执行文件同级 `scripts/` → 源码树 `scripts/` → 三个 agent skill 目录；任一处脚本 + 模板齐全即命中，缺失时明确报错并列出所有探测路径。
- 数据来源严格走 CLI 原语：`trade position --json`（含物理动量雷达）、`trade lot list --status ACTIVE --json`、`trade stats --json`，另以只读方式直连账本 SQLite 聚合历史批次与平仓流水。
- `trade dashboard` 会把子进程 `PATH` 指向当前二进制所在目录，并注入 `LOT_TRADER_DB`/`TRADE_DB_PATH`，保证嵌套 CLI 调用读取**同一个账本**；Python 解释器可用 `$LOT_TRADER_PYTHON` 覆盖（默认 `python3`）。

### 看板内容
1. **数据聚合**：单次生成即聚合全盘持仓、活跃批次明细、物理动量雷达及历史做 T 归因战绩；
2. **严格践行第 3 节呈现规范**：
   - 标的全景卡片（总持仓、现价、浮动盈亏、年线与 60 日空间分位、有效合力与置信等级）；
   - 穿透标的透视卡片支持一键动态排序（持仓市值 / 置信合力 F_eff 双向 / |F_eff| 绝对值 / 5 日动量速度 v / 持仓收益率双向），可与账户切换、雷达态势筛选叠加；
   - 持仓总览表（Layer 2 聚合与多空分层）；
   - 在场批次**时间维度视图**（最新买入倒序）与**盈亏率维度视图**（浮盈/回撤/击球分层透视），子切换卡物理隔离；
   - 历史平仓战绩表与标的穿透 Modal 弹窗；
3. **单文件独立交付**：生成独立便携的深色拟态 HTML 报表，无外部依赖、无须服务端部署。


## 5. 现金分红管理原语 (Dividends Management)

支持标的级/账户级的现金分红流水录入与多维聚合，解决高股息红利资产回报核算脱节问题。

```bash
# 录入一笔现金分红 (支持指定到账金额、除息日、账户与备注)
trade dividend add --symbol 600036.SH --amount 13240.48 --date 2026-07-15 --account CMB --notes "2025分红"

# 机器管道录入
trade dividend add --symbol 600036.SH --amount 13240.48 --account CMB --json

# 查看全量或按标的/账户筛选分红流水 (自动统计总分红金额)
trade dividend list
trade dividend list --symbol 600036.SH
trade dividend list --account CMB
trade dividend list --json
```

### 直接调用脚本（备选）
```bash
python3 scripts/generate_dashboard.py --out /path/to/dashboard.html
# 或 npm script 快捷方式
bun run dashboard
```

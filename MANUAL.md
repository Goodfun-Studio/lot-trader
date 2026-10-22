# Lot-Trader 安装与智能体（Agent）使用手册

本手册用于将 `lot-trader` 单二进制操盘工具部署至 Intel (x86_64) 机器，并指导该机器上的 AI 智能体（如 Clawd、Codex、Claude Code 等）通过命令行接管操盘。

---

## 一、二进制选型与跨平台产物

本机开发环境为 Apple Silicon (arm64)，编译出的默认 `trade` 文件无法在 Intel 机器上直接运行。工程已预先完成跨平台静态编译，产物位于 `dist/` 目录：

- **Intel Mac (macOS x86_64)**：使用 `dist/trade-darwin-x64`
- **Intel Linux (Ubuntu / Debian / CentOS x86_64)**：使用 `dist/trade-linux-x64`

---

## 二、Intel 机器安装步骤

### 1. 复制二进制文件
将对应的二进制文件上传或拷贝到目标 Intel 机器。例如通过 `scp`：

```bash
# 目标机为 Intel Mac
scp dist/trade-darwin-x64 user@intel-mac:/tmp/trade

# 目标机为 Intel Linux
scp dist/trade-linux-x64 user@intel-linux:/tmp/trade
```

### 2. 赋予执行权限并加入 PATH
在目标机器上执行以下命令，将其配置为全局命令：

```bash
chmod +x /tmp/trade
sudo mv /tmp/trade /usr/local/bin/trade
```

*(若无 root 权限，也可放置于 `~/.local/bin/trade`，并确保该目录在 `$PATH` 中)*

### 3. 验证安装
在目标机器终端执行：

```bash
trade --help
```

若成功打印命令帮助信息，即说明安装完成。系统会在初次运行时自动在用户主目录创建并初始化 SQLite 账本：`~/.trade/trade.db`，无需手动配置数据库。

---

## 三、目标机智能体（Agent）接入指引

在目标机器的智能体设定文件（如 `AGENTS.md`、`CLAUDE.md` 或系统提示词）中，追加以下规范片段，智能体即可完整识别并调用操盘命令。

### 智能体专属系统提示词片段 (Prompt Injection)

```markdown
## 投资操盘工具 (lot-trader) 使用规范

本机已安装独立操盘引擎 `trade`，数据驻留在本地 SQLite (`~/.trade/trade.db`)。当你需要执行买入、加仓、批次查询、盘中扫描或平仓时，直接通过 Bash 调用 `trade` 命令。

### 核心交互铁律
1. **优先使用 `--json` 参数**：智能体执行所有子命令时均需追加 `--json`，以接收确定性的结构化 JSON 数据流。
2. **批次独立生命周期**：每次建仓生成独立 Lot。浮亏超 -20% 属于深跌等待加仓区，绝不冻结。
3. **加仓防抖守卫**：梯级加仓执行 `trade lot add`，系统会自动限制 48 小时同源冷却并计算整百股数。
4. **单标的 30% 仓位硬顶**：买入前系统会自动核算组合占比，超 30% 需向用户提示风控预警。
5. **多账户独立核算与底仓代冲强隔离**：支持多券商账户（`--account <ACC>`，默认 `DEFAULT`）。日内代冲做 T 严禁跨账户挪用底仓，加仓默认继承父批次账户。账户元数据由 `trade account list/add` 维护，未登记账户买入时自愈登记。
6. **买卖理由必须可回溯**：建仓/加仓用 `--reason` 记录买入假设，平仓用 `--reason` 记录终局复盘；理由全部可选，不传不阻断录入。

### 命令速查字典
- 录入买入建仓：
  trade lot buy --symbol <代码, 如 518880.SH> --price <单价> --qty <股数, 需整百> [--account <账户代码>] [--reason "买入理由"] --json
  （等价位置参数速记：trade lot buy <代码> <单价> <股数>）

- 梯级逢低加仓：
  trade lot add --parent-lot-id <父批次ID, 如 LOT-20261019-001> --price <当前单价> [--amount 10000] [--qty <股数>] [--account <账户代码>] [--reason "加仓理由"] --json

- 账户注册与查询：
  trade account list [--all] [--json]
  trade account add <account_id> --name <别名> [--broker CMB|CITIC|HTSC|EASTMONEY|GUOTAI|YINHE|GF|PA|FUTU|IBKR|CUSTOM] [--currency CNY] [--json]

- 查看三层深层聚合持仓全景（组合总览 + 标的双仓位与建议点位 + 活跃批次内嵌展开）：
  trade position [--symbol <代码>] [--cap <单标满仓额, 默认50000>] [--account <账户代码>] --json
  （亦可直接 trade position 查看结构分明的高可读三层嵌套 ASCII 报表）

- 查看所有持仓批次：
  trade lot list [--status ACTIVE] [--symbol <代码>] [--account <账户代码>] --json

- 盘中实时扫描信号（含动态跟踪止盈）：
  trade scan [--account <账户代码>] --json

- 指定批次平仓止盈：
  trade lot close --lot-id <批次ID> --price <成交单价> [--qty <平仓数量>] [--account <账户代码>] [--substitute-core] [--reason "平仓理由"] --json
  （等价位置参数速记：trade lot close <批次ID> <成交单价> [数量]）

- 更新批次决策理由（不动会计字段）：
  trade lot edit <批次ID> [--reason "买入理由"] [--close-reason "平仓复盘"] [--append] --json

- 查看历史战绩与多维归因：
  trade stats [--account <账户代码>] --json

- 物理运动量化雷达（速度/加速度/质量/合力/阻尼/换手率置信度）：
  trade physics <代码> [--json]
  （返回 F 与 effective_force；effective_force = F × confidence_weight，
    confidence_level 为 LOW / MEDIUM / HIGH，LOW 时警惕无量虚火，HIGH 为放量真变盘）

- 生成全局交互式 HTML 看板（时间维度 / 盈亏率维度双子切换卡物理隔离）：
  trade dashboard [--out <输出路径>] [--open] --json
  （默认输出当前目录 lot-trader-global-dashboard.html；--open 生成后自动打开浏览器）
  trade serve [--port 8080] [--host 127.0.0.1] [--db <路径>] [--json]
  （启动只读本地 HTTP 引擎，仅监听回环；Ctrl+C / SIGTERM 优雅退出）
```

---

## 四、智能体常见意图响应范例

1. **用户说：“我刚才以 8.55 买入了 2000 股黄金 ETF”**
   - 智能体执行：
     ```bash
     trade lot buy --symbol 518880.SH --price 8.55 --qty 2000 --json
     ```
   - 智能体提取返回的 `lot_id` 与全成本保本单价向用户反馈。

2. **用户说：“帮我看一下今天有没有需要操作的标的”**
   - 智能体执行：
     ```bash
     trade scan --json
     ```
   - 智能体解析返回的 `signals`：
     - 若为 `TAKE_PROFIT_ALERT`：提示用户某批次已盈利达标，建议平仓止盈。
     - 若为 `TRAILING_STOP_ALERT`：提示用户某批次较历史高点回撤 3%，建议移动止盈锁定胜率。
     - 若为 `ADD_POSITION_ALERT` 或 `DEEP_VALUE_ALERT`：提示用户已触及加仓区间，给出建议加仓金额与层级。

3. **用户说：“看下我目前的整体持仓情况 / 某标的总仓位”**
   - 智能体执行：
     ```bash
     trade position --json
     ```
   - 智能体获取各标的聚合指标：总持有股数、可用底仓、加权保本成本、总市值、浮动盈亏、组合仓位占比、以及四档目标决策线（+10%/+20%/-10%/-20%），向用户提供包含组合总览、标的双仓位与建议点位、以及下属活跃批次明细的三层宏观全景分析与日内做 T 决策支持。

4. **用户说：“把批次 LOT-20261019-001 平仓”**
   - 智能体先核对最新行情或根据用户报价执行：
     ```bash
     trade lot close --lot-id LOT-20261019-001 --price 8.90 --json
     ```
   - 智能体向用户汇报实现的净利润金额与战绩。

---

## 五、全局交互式看板（Dashboard）

看板生成已内置为 CLI 原语 `trade dashboard`，二进制自包含定位脚本，无需手工拼接 Python 路径。

```bash
# 默认在当前目录生成 lot-trader-global-dashboard.html
trade dashboard

# 指定输出路径，并生成后自动用系统默认浏览器打开
trade dashboard --out ~/Desktop/dashboard.html --open

# 智能体结构化调用口径
trade dashboard --json
```

| 参数 | 说明 |
| --- | --- |
| `--out, -o PATH` | 输出 HTML 路径（默认 `./lot-trader-global-dashboard.html`） |
| `--open` | 生成后调用系统默认浏览器打开（macOS `open` / Linux `xdg-open` / Windows `start`） |
| `--template, -t PATH` | 前端模板路径（默认使用脚本同目录 `template_base.html`） |
| `--db PATH` | SQLite 账本路径（默认 `$LOT_TRADER_DB` → `$TRADE_DB_PATH` → `~/.trade/trade.db`） |
| `--json` | 返回 `{"code":0,"data":{out,script,template,db,bytes,opened}}`，失败 `code=1` 且退出码 1 |

### 看板双模运行（自驱 ⇄ 本地引擎）

| 模式 | 触发条件 | 行情数据源 | 响应 |
| --- | --- | --- | --- |
| 轻量独立（纯前端自驱，默认） | 未探测到本地引擎 | 页面内嵌标的自去重 → 每 5 秒批量请求 `qt.gtimg.cn` | 指示灯浅灰，文案「模式：轻量独立（纯前端自驱）」 |
| 本地引擎已联动 | 3 秒心跳探测 `http://127.0.0.1:8080/api/health` 成功 | 优先用 `/api/summary` 的本地账本口径 | 指示灯绿色呼吸灯，文案「模式：本地引擎已联动」 |

- 前端按每个标的/批次的成本与数量重算总市值、浮盈金额与收益率，现价变动时单元格红/绿呼吸高亮 1 秒后平滑恢复。
- 非交易时段（15:00 后、午休或周末）自动降频到 60 秒；顶栏【暂停行情刷新】按钮可随时冻结。
- 服务关闭 / 心跳超时 / 网络中断 / 行情接口返回异常文本时**安全降级**：不抛未捕获异常、不出现 `NaN`、不白屏（回退到最近一次有效行情或成本价）。
- 顶栏【启动本地服务】展开轻量引导卡，内含 `trade serve` 命令与【一键复制】。

### 本地微服务原语（trade serve）

```bash
trade serve                              # 默认 127.0.0.1:8080，自动生成会话令牌
trade serve --port 8090 --host 127.0.0.1 --db ~/.trade/trade.db
trade serve --token <固定令牌>            # 指定令牌（退出时不删除凭证文件）
trade serve --token-file /path/session.token   # 指定凭证文件路径
trade serve --json                       # 结构化就绪行（含 token_file / token_source，绝不含令牌本身）
```

| 接口 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /api/health` | 公开 | 存活探针：`{status:"ok", version, db_path, timestamp, host, port, uptime_seconds}`，不含任何账本字段 |
| `GET /api/summary` | 需令牌 | 三层快照：`portfolio`（总成本/市值/浮盈；`full_position_cap` 为**单标的**满仓参考额度 `full_position_cap_scope:"per_symbol"`，组合层不输出全局剩余预算，`remaining_budget`/`budget_utilization_rate` 恒为 `null`）、`accounts`（多账户汇总+战绩+分红）、`symbols`（逐标的现价/市值/浮盈/收益率，含 `cost_position_rate`/`current_position_rate` 单标的额度占用率） |
| `GET /api/lots?symbol=&account=&status=` | 需令牌 | 批次明细（`ACTIVE` / `CLOSED` / `CLOSING` / `ALL`），含现价来源 `price_source` 与 `degraded`/`degraded_reason` |

**本地协议凭证门禁（第三道门，0600 Session Token）**：
- **令牌来源**：默认每次启动用 32 字节 CSPRNG 随机生成（64 hex），也可用 `--token` 固定；写入凭证文件（默认 `$LOT_TRADER_TOKEN_FILE` → `~/.lot-trader/session.token`），写入后 `chmod 0600`，即只有当前操作系统用户可读写。
- **传递方式**：`Authorization: Bearer <token>` 或 `?token=<token>`（SSE / 静态前端兼容通道）。
- **拒绝口径**：无令牌或令牌不匹配 → `401` `{"status":"error","code":"UNAUTHORIZED","message":"未授权：请提供合法的本地会话 Token。"}`，响应**不含任何账本字段**，且鉴权发生在路由与查库之前（因此连非法筛选参数也只会得到 401）。
- **生命周期**：自动生成的令牌在 `SIGINT`/`SIGTERM` 优雅退出时随进程删除；`--token` 显式指定的令牌由老板自己保管，不删除；端口被占用导致启动失败时，不会覆盖/删除正在运行实例的凭证文件。
- **看板无感注入**：`trade dashboard` 读取同一凭证文件并注入 `window.__LOT_TRADER_SESSION_TOKEN__`，看板请求自动带 `Bearer` 头（同时附 `?token=` 备用）；若本地引擎返回 401，看板保持「轻量独立（纯前端自驱）」并提示「本地服务未授权/Token不匹配」，行情轮询不受影响、控制台零未捕获异常。
- **看板文件自身权限（0600）**：看板 HTML 内嵌同一会话令牌，因此 `generate_dashboard.py` 写入时强制 `chmod 0600`（`os.open(O_WRONLY|O_CREAT|O_TRUNC, 0o600)` 创建 + 写入后无条件 `os.chmod` 双保险，覆盖已存在的宽权限文件），生成后自校验权限位必须为 `0o600`，否则直接报错退出。这样即便 umask 允许，同机其他本地用户也无法通过看板文件旁路拿到令牌。

**“查不到 ≠ 没有”降级防线（`degraded`）**：
- `/api/summary` 与 `/api/lots` 均额外返回 `degraded: boolean` 与 `degraded_reason: string | null`；`degraded: true` 表示账本自身状态可疑，此时 0 市值/0 持仓应被读作“未知”，而不是“当前合法空仓”。
- 触发条件：① `trades` 有历史流水但 `lots` 为 0 行（批次表被清空/误切空库）；② `trades` 有历史流水但活跃批次为 0；③ 存在 `CLOSED` 批次但 `trades` 为空（成交流水丢失）；④ `symbols` 表存在但被清空而仍有活跃批次（分类元数据丢失）。
- 负向防误杀：全新的白板空库（无流水、无批次）标记 `degraded: false`，正常渲染空账本。
- 看板前端收到 `degraded: true` 时，顶栏高亮黄色告警条并展示具体原因，坚决不允许静默粉饰。

**硬约束与容错口径**：
1. **只读 + 只监听回环**：拒绝 `0.0.0.0` / 局域网 IP / 域名等任何非 `127.0.0.1`、`localhost`、`::1` 的 host，账本永不出本机；
2. 端口被占用时输出可操作性中文文案并退出码 1（不是崩溃堆栈），提示确认已有实例或换端口；
3. `SIGINT` / `SIGTERM` 优雅停机并释放端口；
4. 行情拉取失败时按批次成本价兜底（`price_source: "cost_basis"`），任何字段都不会是 `NaN`。

**浏览器安全门（两道，均在路由前生效）+ 本地凭证门（第三道）**：
1. **Host 校验（防 DNS rebinding）**：`Host`（HTTP/2 的 `:authority`）主机部分必须精确等于 `127.0.0.1` / `localhost` / `[::1]`（可带端口），否则一律 403 `HOST_NOT_ALLOWED`。仅绑回环不够——攻击者可用 DNS rebinding 把恶意域名解析到 127.0.0.1 从而变成同源；
2. **Origin 白名单（防 CORS 窃取）**：只放行 `Origin: null`（`file://` 打开的本地看板）与回环 origin（`http(s)://127.0.0.1[:port]`、`localhost[:port]`、`[::1][:port]`），并回显该 origin + `Vary: Origin`；其它 origin（含 `file://` 之外的任意第三方站点、`chrome-extension://`）直接 403 `ORIGIN_NOT_ALLOWED`，且**响应里不出现任何 `Access-Control-Allow-Origin`**；无 `Origin`（curl / 本机脚本）正常放行且不带 CORS 头。

> 显式禁止：`Access-Control-Allow-Origin: *`。它会让任何开着 trade serve 的浏览器标签页（广告脚本、恶意页面）静默读走完整账本。

> 已闭环的残余风险：`Origin: null` 无法与沙箱化 iframe 区分（`<iframe sandbox>` 也发 `Origin: null`）。仅靠 CORS + Host 两道门拦不住这种盲打，因此账本接口一律要求 0600 凭证文件里的会话令牌（第三道门）；无令牌的沙箱 iframe 只能拿到 401。

> 注：`trade serve` 不设置 `development: false` —— 该选项会让 Bun 启用 `SO_REUSEPORT`，导致两个引擎静默共用同一端口并互相抢占请求。

**部署说明（Intel 机器同样适用）**：
1. 把 `dist/trade-*` 与仓库 `scripts/` 目录（`generate_dashboard.py` + `template_base.html`）一起部署，`scripts/` 与 `trade` 二进制同级即可被自动发现；
2. 目标机需具备 `python3`（可用 `LOT_TRADER_PYTHON` 指定解释器）；
3. 若 `scripts/` 放在别处，设置 `LOT_TRADER_SCRIPTS_DIR` 指向该目录，或用 `--scripts-dir` 显式指定；
4. 看板通过嵌套 `trade position/lot list/stats --json` 取数，`trade dashboard` 会自动把子进程 `PATH` 指向当前二进制，保证嵌套调用与主进程读同一账本。

---

## 六、物理雷达「博弈参与度与合力置信度」口径说明

`trade physics` / `trade position` 中的合力指标分为两层：

| 字段 | 含义 | 用途 |
| --- | --- | --- |
| `F` | 原始多空合力 F = m × a（惯性质量 × 加速度） | 客观力度，不区分真假 |
| `turnover_rate` | 当日真实换手率 τ（%，腾讯行情第 38 项） | 判断参与博弈的筹码规模 |
| `confidence_weight` | 置信度加权系数 W_conf = W_abs(τ) × W_rel(γ)，钳制 [0.10, 2.00] | 给力度打折 / 加成 |
| `confidence_level` | `LOW` / `MEDIUM` / `HIGH` | 直观参与度等级 |
| `effective_force` | 有效置信合力 F_eff = F × W_conf | 决策实际依据 |

- `γ = τ / τ̄20`，无历史换手率序列时以成交量倍数 `m = Vol_today / MA20(Vol)` 等价替代（同一流通股本下二者数学等价）。
- 等级门槛：`W_conf < 0.80` → LOW（无量虚火，强 F 只作候选）；`0.80 ≤ W_conf < 1.20` → MEDIUM（正常中枢）；`W_conf ≥ 1.20` → HIGH（天量对决，真变盘）。
- 换手率缺失 / 0 / 负数 / 异常时安全降级：`W_abs` 取中性 1.0，`W_conf` 封顶 1.20，等级永不报 HIGH，全链路不产生 NaN。
- 铁律：**原始 F 不被篡改**，仅新增 `effective_force` 派生字段，历史调用方（不传换手率）行为保持向后兼容。


### 8. 现金分红管理原语 (trade dividend)
- **录入分红**: `trade dividend add --symbol <SYM> --amount <AMOUNT> [--date <YYYY-MM-DD>] [--account <ACC>] [--shares <N>] [--per-share <P>] [--notes <TXT>] [--json]`
- **查看流水**: `trade dividend list [--symbol <SYM>] [--account <ACC>] [--json]`
  - 自动输出累计分红总额及逐笔到账详情；
  - 严格支持多账户隔离过滤。

### 9. 多账户注册表与买卖理由沉淀
- **账户注册表**：`accounts(account_id, name, broker_code, currency, is_active, created_at)`。旧库首次打开自动回填历史流水里出现过的账户。
- **买入理由**：`lots.buy_reason` + BUY 流水 `trades.reason`；**平仓复盘**：`lots.close_reason`（多次部分平仓换行累积）+ SELL 流水 `trades.reason`。
- **容错口径**：任何未传 `--reason` 的调用均写入 `NULL`，保持完整向后兼容；`trade lot edit` 可事后补记，空字符串可清空。
- **硬约束**：账户 ID 限 1-32 位 `[A-Za-z0-9._-]`；券商代码仅限预设枚举；币种为 3 位 ISO 4217。非法输入直接报错，不会污染账本。

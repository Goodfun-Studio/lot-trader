# lot-trader

单笔批次独立盈亏监控与加仓止盈操盘核心引擎 (TypeScript + Bun 单二进制架构)。

## 架构特性
- **TypeScript + Bun 单二进制原生交付**：基于 `bun build --compile` 编译生成零外部依赖、秒级启动的单一独立可执行二进制文件 `./trade`。
- **高性能原生嵌入式持久化**：采用 Bun 原生内置 `bun:sqlite`（C 级别 SQLite 引擎），兼顾极致读写性能与本地私密安全。
- **全生命周期逐批次独立账本**：精确核算单笔全成本保本单价、独立浮动盈亏与实现净利润。
- **加仓闭环执行与血缘防抖守卫 (Pyramid Dip Buy & Lineage Guard)**：
  - 专用加仓原语 `trade lot add --parent-lot-id <LOT-ID> --price <PRICE> [--amount <AMOUNT>] [--qty <QTY>]`；
  - 支持基准金额等额法 ($M_{add} = M_{base}$，默认 10,000 元)，自动按 100 股向下取整；
  - 自动绑定父子血缘关系，加仓层级递增 (`pyramid_level = parent.pyramid_level + 1`)；
  - **48 小时防抖冷却窗口守卫 (Anti-shake Cooldown)**：同源血缘链在 48 小时内若已加仓，严格拦截频密补仓，防急跌耗尽子弹。
- **动态跟踪止盈扫描机制 (Trailing Stop / Peak Tracking)**：
  - 增补 `peak_price` 与 `trailing_stop_active` 字段；
  - 浮盈触及激活线（默认 +15%）自动激活移动止盈；
  - 动态跟踪历史最高价，从最高价回撤超阈值（默认 3%）即刻触发 `TRAILING_STOP_ALERT` 锁定高位利润。
- **单标的 30% 仓位硬顶组合级风控中间件 (Position Cap & Risk Guard)**：
  - 买入/加仓前置核算该标的在投资组合中的持仓占比；
  - 超过 30.00% 组合级硬顶红线时坚决触发风控拦截，阻断无序重仓。
- **多券商账户注册表与买卖理由沉淀 (Accounts & Decision Thesis)**：
  - `accounts` 表维护 `account_id / name / broker_code / currency / is_active`，支持券商预设 (`CMB`…`IBKR`/`CUSTOM`)；
  - `trade account list/add` 原语；未登记账户买入时自愈登记，快捷录入永不中断；
  - `lots.buy_reason` / `lots.close_reason` + `trades.reason` 全链路记录建仓假设、平仓复盘与单笔动机，缺省为 `NULL` 完全向后兼容。
- **全局交互式看板原生原语**：`trade dashboard [--out <path>] [--open]` 一键生成单文件 HTML 全景看板（标的全景卡片 / 持仓总览 / 时间维度与盈亏率维度物理隔离的批次双视图 / 平仓战绩与穿透弹窗）。看板账户切换器完全由账本动态生成，零硬编码券商字面量。
- **看板双模运行（纯前端自驱 ⇄ 本地引擎联动）**：
  - **轻量自驱模式**（默认）：静态单文件直接打开即可，页面自动去重标的并每 5 秒批量轮询腾讯财经接口，前端按各批次成本/数量重算总市值、浮盈与收益率；现价变动触发红/绿 1 秒呼吸高亮；非交易时段自动降频至 60 秒，并可用【暂停/继续行情刷新】随时冻结。
  - **本地引擎联动模式**：看板每 3 秒心跳探测 `http://127.0.0.1:8080/api/health`，联通即无缝转绿并优先对齐本地服务口径；服务关闭或超时后平滑回退自驱模式，全程不抛未捕获异常、不出现 `NaN` 与白屏。
- **本地微服务原语 `trade serve`**：基于 Bun 原生 HTTP 的只读 JSON 引擎，**仅监听 127.0.0.1 回环**（拒绝任何非回环 host，账本不出本机），提供 `/api/health`、`/api/summary`、`/api/lots?symbol=&account=&status=`，端口冲突给出可读文案而非崩溃堆栈，SIGINT/SIGTERM 优雅停机。**只读即只读**：`--db` 指向的文件不存在时直接以退出码 1 拒绝并打印 `数据库文件不存在`，**绝不隐式建库、绝不写 WAL**；指定了外部 `--db` 时也绝不打开/触碰默认账本 `~/.trade/trade.db`。`?account=` 大小写不敏感（`cmb` / `CMB` / `Cmb` 等价），未登记账户返回 `400 非法账户代码`，数据库层真故障返回 `500 DATABASE_ERROR` 而非伪造空仓 200。
- **本地协议凭证门禁（0600 Session Token）**：`/api/summary`、`/api/lots` 必须携带 `Authorization: Bearer <token>` 或 `?token=`；令牌默认每次启动随机生成 32 字节（64 hex）并写入 `~/.lot-trader/session.token`（`chmod 0600`），退出即删；无/错令牌一律 401 `UNAUTHORIZED` 且响应不含任何账本字段。安全边界从浏览器同源策略下沉到**操作系统文件权限**——连 `Origin: null` 的沙箱 iframe 也无法盲打读取账本。
- **看板文件 0600**：生成的单文件看板内嵌同一令牌，因此 `trade dashboard` 强制以 `0600` 写入（`os.open(..., 0o600)` + 写入后 `chmod` 双保险），不受 umask 影响，并自校验权限位；同机其他本地用户读不到该 HTML。
- **三大支柱全动态**：看板「三大支柱」卡片不再内联任何历史数值或私人标的字面量，而是按账本 `symbols.asset_class`（如 ETF / STOCK / LOF）与账户切片实时聚合市值、占比、浮盈与权重前三；空白或未归类账本渲染中性结构化占位。单测内置负向断言，任何写死老数字回流即构建失败。
- **“查不到 ≠ 没有”降级防线**：`/api/summary` 与 `/api/lots` 返回 `degraded` / `degraded_reason`。当出现「有历史成交流水但批次表为空」「活跃批次为 0」「成交流水表被清空」「标的元数据表被清空」等反常空态时标记降级，看板顶栏高亮黄色告警条；全新空账本仍为 `degraded: false`，防空警报误报。
- **批次部分平仓与战绩多维归因**：
  - 支持指定数量部分平仓，状态保持 `ACTIVE` 持续监控；
  - `trade stats` 提供按标的明细、按操盘类型（普通波段、天然 T+0、底仓代冲做 T）的多维战绩归因。
- **`--db` 全局参数全链路隔离**：`--db <path>` 在 CLI 最顶层统一提取并贯穿**全部子命令**（`lot` / `account` / `position` / `scan` / `stats` / `physics` / `dividend` / `dashboard` / `serve`），优先级 `--db` > `$LOT_TRADER_DB` > `$TRADE_DB_PATH` > `~/.trade/trade.db`；支持位置穿插与 `--db=PATH` 写法，不再有「传了 `--db` 但被静默忽略、实际仍读写默认库」的假隔离。
- **`--help` 零写库守卫**：顶级与全部一级/二级子命令（含 `trade scan --help`、`trade lot buy --help`、`trade dividend add --help`）在执行任何参数解析之前短路 `-h/--help`，打印用法后以退出码 `0` 退出，绝不实例化数据库、绝不建库/迁移/写入（`trade scan --help` 不再扫描、不再写 `signals`）。

## 快速使用

### 1. 构建与测试
```bash
# 运行全量核心测试（100% 通过）
bun test

# 编译生成单一独立可执行文件 trade
bun run build
```

### 2. 命令行核心操作
```bash
# 账户注册与查询
./trade account add CMB_MAIN --name "招商稳健仓" --broker CMB --json
./trade account list

# 买入建仓并沉淀决策理由（同时支持位置参数速记）
./trade lot buy --symbol 518880.SH --price 6.120 --qty 2000 --account CMB_MAIN --reason "避险底仓 + 央行增持" --json
./trade lot edit LOT-20261019-001 --reason "升级：降息周期加码" --json

# 梯级加仓（自动绑定血缘并受 48h 防抖守卫保护）
./trade lot add --parent-lot-id LOT-20261019-001 --price 5.500 --amount 10000 --json

# 批次持仓监控
./trade lot list
./trade lot list --json

# 盘中信号扫描（含常规止盈、移动跟踪止盈、逢低加仓与深跌击球区信号）
./trade scan
./trade scan --json

# 批次平仓（支持全额或部分平仓、底仓代冲做 T，并沉淀平仓复盘）
./trade lot close --lot-id LOT-20261019-001 --price 7.050 --qty 1000 --reason "触及 +15% 移动止盈" --json
./trade lot close --lot-id LOT-20261019-002 --price 1670.00 --substitute-core --json

# 现金分红流水管理
./trade dividend add --symbol 600036.SH --amount 13240.48 --account CMB --date 2026-07-15
./trade dividend list
./trade dividend list --json

# 操盘战绩多维归因统计报表
./trade stats
./trade stats --json

# 全局交互式 HTML 看板（默认当前目录 lot-trader-global-dashboard.html，--open 自动打开浏览器）
./trade dashboard
./trade dashboard --out /tmp/dashboard.html --open --json

# 本地微服务引擎（只读 JSON，仅监听 127.0.0.1；Ctrl+C 优雅退出）
./trade serve
./trade serve --port 8080 --host 127.0.0.1 --db ~/.trade/trade.db
./trade serve --token <固定令牌> --token-file /path/to/session.token
curl -s http://127.0.0.1:8080/api/health          # 公开探活，无需令牌
TOKEN=$(cat ~/.lot-trader/session.token)          # 0600 凭证文件（仅当前用户可读）
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/api/summary
curl -s "http://127.0.0.1:8080/api/lots?symbol=518880&status=ACTIVE&token=$TOKEN"
```

> 看板生成器资产固化在 `scripts/`（`generate_dashboard.py` + `template_base.html`），随二进制同级部署即可被 `trade dashboard` 自动发现。
>
> 看板与本地引擎是**可选叠加**关系：不启动 `trade serve` 时看板以纯前端自驱运行；启动后看板顶栏指示灯 3 秒内自动转绿并优先使用本地账本口径，关闭服务后自动回退，无需刷新页面。

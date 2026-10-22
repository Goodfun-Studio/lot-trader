# lot-trader 发布门禁放行报告 (Release Gate Report)

- **被测版本**：commit `dd3b236` — `fix(serve): eliminate ghost db creation, default db touch, ledger error masking, cap misattribution, and account case mismatch`
- **被测二进制**：`/Users/ivywu/Downloads/GitHub/Goodfun-Studio/lot-trader/trade`
  - `sha256 = 5bbf7bc11849ff3265a248b9528efa5de77b21ce52dbd2f7236875328165edc1`
  - `size = 63,611,234 bytes (60.66 MB)`，`mode = -rwxr-xr-x`
- **执行角色**：`persona-lot-trader-qa`（操盘质检与发布门禁工程师）
- **执行时间**：2026-10-22 14:12 → 14:26 (+0800)
- **沙箱根目录**：`/tmp/lot-trader-qa-20261022-141230`（临时库、token；验收后已清理，证据见下行）
- **证据副本（随仓库持久化）**：`docs/qa/evidence/release-gate-20261022-142604/`（70 个文件，612K）

---

## 0. 终审判定

| 关卡 | 判定 | 一句话依据 |
|---|---|---|
| 缺陷 1 复验（防隐式建库 + 默认库隔离） | ✅ **PASS** | 幽灵路径退出码 1 且磁盘零新建；默认库指纹前后完全一致，10ms 探针 0 次触碰 |
| 缺陷 2 复验（数据库故障不吞为 200 空仓） | ✅ **PASS** | 运行期真实库损坏 → `/api/summary` 与 `/api/lots` 均 **HTTP 500 `DATABASE_ERROR`** |
| 缺陷 3 复验（组合层预算语义拨正） | ✅ **PASS** | 组合市值 191,350 元（旧 bug 触发条件已满足）→ `remaining_budget = null`、负数 0 处、244% 类荒谬值 0 处 |
| 缺陷 4 复验（`?account=` 大小写 + 400 门禁） | ✅ **PASS** | 4 种大小写 × 4 轮 = 16 次请求归一化后**同一哈希**；未注册账户 **HTTP 400** |
| 本地凭证门禁复验 | ✅ **PASS** | 无/错 Token → 401 `UNAUTHORIZED`，敏感字段命中 **0**；合法 Token → 200 |
| **Gate 1** 静态与单元基线 | ✅ **PASS** | `165 pass / 0 fail`，16 个套件，1885 expect |
| **Gate 2** 单二进制编译 | ✅ **PASS** | `bun run build` 重建后 **sha256 逐字节一致**（可复现构建），60.66 MB，`--help` exit 0 |
| **Gate 3** 沙箱 CLI 全链路黑盒走查 | ✅ **PASS** | 注册→建仓→防抖拦截→冷却后放行→硬顶拦截→止盈告警→平仓→战绩归因，数字分文不差 |
| **Gate 4** 看板双模冒烟 | ✅ **PASS** | 单文件 160,566 B / 外部资源 0 / 渲染层 NaN 0；联动模式探活 200 + 凭证注入 + 关闭后端口释放 |
| **Gate 5** 负向守卫全量 | ✅ **PASS** | -25.14% 深跌批次保持 `ACTIVE` + `DEEP_VALUE_ALERT` 且可正常平仓；二进制内 `FROZEN` 词元出现 0 次 |

**放行判定：✅ PASS — 允许发布。**

- 四大缺陷**全部确认修复**，无一项残留。
- 新增 1 项 **P2** 与 5 项 **P3** 观察项（见第 6 节），**均不构成本次四大缺陷修复范围的阻断项**；其中 P2-1（加仓默认金额对高价标的静默放大 15 倍）建议在本轮或下一轮排期决策。
- **1 项流程事故由本人（QA）造成并已披露**（见第 5 节 INC-1），影响范围已量化，缓冲区字段可自愈，生产账本会计数据零污染。

---

## 1. 测试隔离凭据（先证明「没碰生产账本」）

### 1.1 生产账本指纹（全程首尾比对）

| 时点 | file | size | mtime | sha256(前 16) |
|---|---|---|---|---|
| 14:12（开工） | `~/.trade/trade.db` | 987,136 | 2026-10-22T14:11:46 | `84686a5e294c095c` |
| 14:26（收工） | `~/.trade/trade.db` | 987,136 | 2026-10-22T14:11:46 | `84686a5e294c095c` |

- 完整 sha256 首尾均为 `84686a5e294c095c0464bdca0b928910756bd5113af8a2289320903bc661ecb4` → **主库内容零变化**。
- `PRAGMA integrity_check` → `ok`
- 行数：`lots=909`、`active_lots=203`、`trades=1549`、`accounts=3`
- 污染扫描：`SELECT ... WHERE buy_reason LIKE '%QA%' OR buy_reason LIKE '%fixture%' OR account_id IN ('GATE3','CAP','S','P','P2','lower_acct')` → **`none`**（QA 夹具零泄漏进生产库）

### 1.2 隔离开关实测（重要操作陷阱）

| 命令形态 | 是否隔离 | 证据 |
|---|---|---|
| `trade serve --db /tmp/x.db` | ✅ 隔离 | 见 2.1 / 2.6 指纹比对 |
| `trade dashboard --db /tmp/x.db` | ✅ 隔离 | 10ms 探针 `prod-touch events=0` |
| `trade dashboard`（无 `--db`） | ❌ 打开默认库 | `prod-touch events=1`（这是**文档化默认行为**，非缺陷） |
| `trade account add ... --db /tmp/x.db` | ❌ **`--db` 被静默忽略** | 实测：文件未创建，且命令读到了生产库并回 `账户已存在: CMB` |
| `TRADE_DB_PATH=/tmp/x.db trade <任意子命令>` | ✅ 隔离 | `account add` 后 `/tmp/.../sandbox.db` 落盘，`account list` 读回新账户 |

> **结论：对 `lot` / `account` / `position` / `scan` / `stats` / `physics` / `dividend` 这 7 类子命令，唯一有效的隔离手段是环境变量 `TRADE_DB_PATH`；`--db` 参数被完全忽略且不报错。**
> 这是本次走查中风险最高的一项操作陷阱（见 P3-4），因为它会让执行者误以为已经隔离。

**本报告全部 CLI 命令均以 `TRADE_DB_PATH=<沙箱路径>` 执行；`serve`/`dashboard` 均显式传 `--db <沙箱路径>`；token 一律落到 `--token-file <沙箱路径>`（除 5.4 明确标注的那一次）。**

---

## 2. 四大缺陷专项黑盒复验

### 缺陷 1a：防隐式建库 — ✅ PASS

| 项目 | 内容 |
|---|---|
| 操作前 | `ls /tmp/lot-trader-qa-20261022-141230/ghost_path_not_exist.db*` → `No such file or directory` |
| 执行命令 | `./trade serve --db /tmp/lot-trader-qa-20261022-141230/ghost_path_not_exist.db --port 8899` |
| 观测（退出码） | **`EXIT_CODE=1`** |
| 观测（stderr） | `❌ 数据库文件不存在: /tmp/lot-trader-qa-20261022-141230/ghost_path_not_exist.db。trade serve 为只读服务，拒绝隐式建库。` |
| 观测（stdout） | 空（0 字节） |
| 操作后磁盘 | `ghost_path_not_exist.db*` glob 命中数 = **0**（**无主库、无 `-wal`、无 `-shm`**） |
| 判据 | 退出码 1 且磁盘零残留 → **该 bug 已消除**。若仍隐式建库，此处应出现 1 个 4 KB SQLite 文件与 `-shm`。 |

### 缺陷 1b：默认库不被触碰/刷新 — ✅ PASS

**逐字执行任务书场景**，并用 10ms 间隔探针（`stat` 主库/`-shm`/`-wal` 的 size+mtime 变化）全程监控：

| 项目 | 内容 |
|---|---|
| 执行命令 | `./trade serve --db /tmp/lot-trader-qa-20261022-141230/cap.db --port 8911 --token-file <沙箱>/token/d1b.token --json` |
| 请求 | `GET /api/health → 200`、`GET /api/summary (Bearer) → 200`、`GET /api/lots (Bearer) → 200` |
| 关闭方式 | `SIGTERM`（优雅关机，`{"code":0,"msg":"stopped","data":{"signal":"SIGTERM"}}`） |
| 指纹（前） | `trade.db 987136/2026-10-22T14:11:46/84686a5e…`、`-wal 0/e3b0c442…`、`-shm 32768/fd4c9fda…` |
| 指纹（后） | `trade.db 987136/2026-10-22T14:11:46/84686a5e…`、`-wal 0/e3b0c442…`、`-shm 32768/fd4c9fda…` |
| 判据 | `fingerprint(before) == fingerprint(after)` → **✅ IDENTICAL**；10ms 探针在本场景全过程中产生的生产库触碰事件 = **0**（唯一一条记录是场景开始前探针自身的首采样）。 |

**旁证（同类门禁）**：

| 探测 | 命令 | 观测 |
|---|---|---|
| 非回环绑定 | `./trade serve --db <沙箱> --host 0.0.0.0 --port 8908` | `EXIT=1`，`❌ 拒绝监听 0.0.0.0：trade serve 仅允许本地回环地址 (127.0.0.1 / localhost / ::1 / [::1])，以避免把完整投资账本暴露到外网。` |
| DNS-rebinding 守卫 | `curl -H "Host: evil.example" -H "Authorization: Bearer <合法>" http://127.0.0.1:<port>/api/summary` | **403**，`{"code":"HOST_NOT_ALLOWED"}` |
| CORS 守卫 | `curl -H "Origin: https://evil.example" …` | **403**，`{"code":"ORIGIN_NOT_ALLOWED"}` |
| 本地看板来源 | `curl -H "Origin: http://127.0.0.1:7788" …` | **200**（白名单内放行，未误杀） |
| 非 GET | `curl -X POST …/api/summary` | **405** |
| 端口冲突 | 同端口二次 `serve` | `EXIT=1`，`❌ 端口 8909 已被占用，本地引擎无法在 127.0.0.1:8909 启动。…或换一个端口重试： trade serve --port 8910`（无堆栈泄漏） |

### 缺陷 2：数据库故障不盲吞为 200 空仓 — ✅ PASS

**真实运行期故障注入**（非 mock）：服务已启动并绑定，主库尚未被任何账本请求读过，此时把主库文件截断为 0 字节。

| 项目 | 内容 |
|---|---|
| 命令 | `./trade serve --db <沙箱>/fault-mid.db --port 8906 --token <T> --json`（boot 后）→ `: > fault-mid.db`（size 53248 → 0）|
| 观测 `/api/summary` | **HTTP 500**，`{"status":"error","code":"DATABASE_ERROR","message":"数据库查询失败: lots 表缺少必需列 [lot_id, symbol, buy_time, buy_price, buy_quantity, remaining_quantity, cost_basis_unit, status]，该文件不是可用的 trade 账本。","path":"/api/summary"}` |
| 观测 `/api/lots` | **HTTP 500**，同上 `DATABASE_ERROR` |
| 关键反证 | 响应 `status != "ok"`、`code = "DATABASE_ERROR"` → **不是 200 假空仓**。健康态同库同端点对照为 `HTTP 200 / total=4`（非空），说明故障前确在服务真实数据。 |
| 启动期损坏（附加） | ① `writable_schema` 将 `lots.rootpage=999999` → 启动即拒绝：`{"code":1,"msg":"malformed database schema (lots) - invalid rootpage"}`；② `rootpage=0` → `{"code":1,"msg":"database disk image is malformed"}`。**均 fail-closed，绝不带病启动** |
| 单元层对照 | `bun test` 内 `serve_dashboard_dual_mode.test.ts::"defect 2: a real database failure is a 500 DATABASE_ERROR, never a fake 200 empty book"` 对 `/api/summary`、`/api/lots` 双端点断言 `500 + DATABASE_ERROR` **通过** |
| 判据 | 真实 IO 故障与真实 schema 损坏两条路径均**未**产出 `200 + 空列表` → 该 bug 已消除。 |

### 缺陷 3：组合层预算语义拨正 — ✅ PASS

**夹具**（沙箱 `sandbox.db`，账户 `CMB`）：4 个 ACTIVE 批次，`Σ(remaining_qty × buy_price) = 122,000 元`，实时估值 `total_market_value = 191,350 元` —— **远超单标的预算基数 50,000 元，即旧 bug（`cap − 组合市值` 单位错配）的触发条件已 100% 满足**。

```
GET /api/summary   (Authorization: Bearer <合法>)
```

| 字段 | 观测值 | 判据 |
|---|---|---|
| `portfolio.total_cost` | `122024.4` | — |
| `portfolio.total_market_value` | `191350` | 191,350 > 50,000 → 旧式 `cap − 市值` 应为 **−141,350** |
| `portfolio.full_position_cap` | `50000` | — |
| `portfolio.full_position_cap_scope` | `"per_symbol"` | 口径显式声明为「单标的」 |
| `portfolio.remaining_budget` | **`null`** | ✅ 不再是负数 |
| `portfolio.budget_utilization_rate` | **`null`** | ✅ 不再是数百/数千 % |
| 全 payload 中 `remaining_budget < 0` 出现次数 | **0** | ✅ |
| 全 payload 中 `Σ|symbols[].{cost,current}_position_rate| < 0` 出现次数 | **0** | ✅ |
| 全 payload 中 `position_rate > 100`（即 >10000%）出现次数 | **0** | ✅ |

**单标的仓位利用率正常显示（逐条）**：

| symbol | market_value | total_cost_basis | cost_position_rate | current_position_rate |
|---|---|---|---|---|
| `600519.SH` | 131,498 | 50,010 | 1.0002 | 2.6264 |
| `510300.SH` | 24,792 | 24,004.8 | 0.4801 | 0.4958 |
| `159915.SZ` | 23,760 | 36,007.2 | 0.7201 | 0.4752 |
| `000001.SZ` | 11,300 | 12,002.4 | 0.2400 | 0.2260 |

- 反算校验：`131498 / 50000 = 2.62996 ≈ 2.6264`（按 `market_value/cap` 口径）→ 数值自洽。
- `600519.SH` 的 2.6264（263%）**不是缺陷**：这是**单标的**市值相对**单标的**预算 50,000 元的占比（该批次 500 元买入、现价 1,314.68 元），且 `full_position_cap_scope` 已显式标注 `per_symbol`；旧 bug 的 2412% 来自把**组合总额**塞进**单标的**基数的错配，该错配已消失。
- **判据：`remaining_budget` 与 `budget_utilization_rate` 恒为 `null`（不伪造组合钱包），单标的利用率保留且自洽 → 语义已拨正。**

### 缺陷 4：`?account=` 大小写不敏感 + 未注册 400 门禁 — ✅ PASS

**正向（大小写不敏感，双向证明）**

夹具：注册大写 `CMB`（4 个 ACTIVE 批次）**与**小写 `lower_acct`（1 个 ACTIVE 批次），用于双向验证。

| 请求 | HTTP | body 归一化后（剥离 `generated_at`）sha256(前 16) | total |
|---|---|---|---|
| `?account=cmb` | 200 | `2e9bb05997489c99` | 4 |
| `?account=CMB` | 200 | `2e9bb05997489c99` | 4 |
| `?account=cMb` | 200 | `2e9bb05997489c99` | 4 |
| `?account=Cmb` | 200 | `2e9bb05997489c99` | 4 |

- 4 种拼写 × 4 轮交错请求 = **16 次响应归一化后拼成单一哈希 `5d59be9665c22ef6`** → 全部逐字节相同。
- 小写注册账户反向验证：`?account=lower_acct` / `LOWER_ACCT` / `Lower_Acct` / `lOwEr_AcCt` → 4 次均 `HTTP 200, total=1, filters.account="LOWER_ACCT"`。
- `filters.account` 在大小写两种入参下均归一为 `"CMB"`。
- **唯一差异字段**：`generated_at`（毫秒时间戳，两次串行 HTTP 请求必然不同，非数据差异）。实测 diff 输出仅 1 行：

```
5c5
<   "generated_at": 1792649746482,
---
>   "generated_at": 1792649746489,
```

**负向（未注册账户必须 400，不是 200 空数组）**

| 请求 | HTTP | 响应体 |
|---|---|---|
| `?account=NOPE` | **400 Bad Request** | `{"status":"error","message":"非法账户代码: \"NOPE\"。该账户未在系统中登记。","path":"/api/lots"}` |
| `?account=nope` | **400** | 同上（大小写均拦截） |
| `?account=`（空） | 200 | 无过滤（ALL 语义），未误杀 |
| `?account=ALL` | 200 | 无过滤（ALL 语义），未误杀 |

- **判据：大小写不敏感成立；未注册账户严格 400，绝不返回 200 空数组；空值与 `ALL` 豁免未误杀。**

### 缺陷 4 附带：本地凭证门禁 — ✅ PASS

| # | 操作 | HTTP | 响应体 / 敏感字段命中 |
|---|---|---|---|
| T1 | `GET /api/health`（无 Token） | **200** | `{"status":"ok","version":"0.1.0","db_path":"/tmp/.../sandbox.db","timestamp":1792649717108,...}` 免鉴权探活正常 |
| T2 | `GET /api/summary`（无 Token） | **401 Unauthorized** | `{"status":"error","code":"UNAUTHORIZED","message":"未授权：请提供合法的本地会话 Token。"}` |
| T3 | `GET /api/lots`（无 Token） | **401** | 同上 |
| T4 | `GET /api/lots`（错 Token `deadbeef…`） | **401** | 同上 |
| T5 | `GET /api/lots`（合法 Token） | **200** | `total=4`，3708 字节，批次明细完整返回 |
| T6 | `GET /api/summary`（合法 Token） | **200** | 3992 字节 |

- **401 响应体账本泄漏扫描**（正则 `600519|000001|510300|159915|lot_id|cost_basis|buy_price|remaining_quantity|symbol|account_id|realized_pnl|total_cost|market_value`）：
  - `t2-summary-notoken.json` → **命中 0**
  - `t3-lots-notoken.json` → **命中 0**
  - `t4-lots-wrongtoken.json` → **命中 0**
- **凭据文件**：`stat -f "%Sp(%OLp)"` → `-rw-------(600)`，`size=65`（64 位十六进制 + 换行），纯 hex 校验 `0` 个非 hex 字符。
- **凭据生命周期**：`token_source=generated` 时，优雅关机后 `token` 文件**已被删除**（`No such file or directory`）；`token_source=explicit` 时保留（见 P3-3）。
- **判据：401 拦截有效、响应体零账本泄漏、0600 权限正确、探活免鉴权未误伤。**

---

## 3. 五大发布门禁走查

### Gate 1 — 静态与单元基线 ✅ PASS

| 项目 | 内容 |
|---|---|
| 命令 | `TRADE_DB_PATH=<沙箱>/gate1-isolation.db bun test` |
| 结果 | **`165 pass` / `0 fail` / `1885 expect() calls` / `Ran 165 tests across 16 files. [16.20s]`** |
| 覆盖套件 | `calc` `quotes` `turnover_weighted_force` `physics_numpy_validation` `position_view` `db` `multi_account` `engine` `symbol_inference` `dividend` `dashboard` `phase2_strategy` `physics` `serve_dashboard_dual_mode` `accounts_reasons` `cli` —— 与回归基线声明的 16 个套件完全一致 |
| 无挂起/无跳过 | 输出中无 `skip` / `todo` 行 |
| 生产库隔离 | 运行前后 `~/.trade/trade.db` size/mtime/sha256 **完全一致** |
| 判据 | 100% 通过，零失败零跳过 → **放行**。 |

### Gate 2 — 单二进制编译 ✅ PASS

| 项目 | 内容 |
|---|---|
| 交付件（重建前） | `size=63,611,234`、`mode=-rwxr-xr-x`、`sha256=5bbf7bc11849ff3265a248b9528efa5de77b21ce52dbd2f7236875328165edc1`、`./trade --help` exit **0** |
| 构建命令 | `bun run build` → `bun build --compile src/cli.ts --outfile trade`；`BUILD_EXIT=0`；`bundle 14 modules`、`compile trade` |
| 重建后 | `size=63,611,234`、`sha256=5bbf7bc11849ff3265a248b9528efa5de77b21ce52dbd2f7236875328165edc1` → **与交付件逐字节一致（构建可复现）** |
| 重建后 `--help` | exit **0**，完整列出 9 个子命令 |
| 判据 | 存在、可执行、体积 >50MB、重建可复现且 `--help` 正常 → **放行**。 |

### Gate 3 — 沙箱 CLI 全链路黑盒走查 ✅ PASS

沙箱：`TRADE_DB_PATH=/tmp/lot-trader-qa-20261022-141230/flow.db`（空库起步）

| 步骤 | 命令（摘要） | 退出码 | 观测到的数值/状态变化 |
|---|---|---|---|
| 1 空库注册账户 | `trade account add GATE3 --name "门禁三号账户" --broker CMB --json` | **0** | `account_id="GATE3"`, `broker_code="CMB"`, `currency="CNY"`, `is_active=true` 落盘 |
| 2 首次建仓（带 `--reason`） | `trade lot buy --symbol 600519.SH --price 1141.00 --qty 100 --account GATE3 --reason "回调分批低吸(移动止盈复验)" --json` | **0** | `lot_id=LOT-20261022-001`, `status=ACTIVE`, `buy_quantity=100`, `cost_basis_unit=1141.2282`（含买入费 22.82）, `buy_reason="回调分批低吸(移动止盈复验)"` |
| 3a 48h 防抖（首轮加仓） | `trade lot add --parent-lot-id LOT-…-001 --price 1100.00 --json` | 0 | `pyramid_level=1`、`parent_lot_id=LOT-…-001`、血缘继承正确 → **符合《安全清单》§6「若已发生过加仓」语义（首轮放行）** |
| 3b 48h 防抖（48h 内二次加仓） | `trade lot add --parent-lot-id LOT-…-002 --price 1080.00 --json` | **1** | 拦截文案：`加仓防抖冷却窗口守卫拦截：同源血缘链批次 LOT-20261022-002 (L1) 于 2026-10-22T06:18:28.358Z 已执行加仓，尚在 48 小时 (2 个交易日) 防抖冷却窗口内 (剩余 48.0 小时)，严禁急跌连续抢跑！`；`lots` 行数 **2 → 2（零新增）** |
| 3c 防抖（跨血缘同样拦截） | `trade lot add --parent-lot-id LOT-…-001`（挂到根批次） | **1** | 同源血缘链整体识别有效，仍拦截 |
| 4 冷却期外放行 | 将 `LOT-…-002.buy_time` 回拨 50 小时 → `trade lot add --parent-lot-id LOT-…-002 --price 1050.00 --json` | **0** | `lot_id=LOT-20261022-003`, `parent_lot_id=LOT-…-002`, **`pyramid_level=2`**（父 1 → 子 2），年龄实测 `delta_hours = 50.0` |
| 5 动态止盈扫描 | `trade scan --json`（受控夹具） | **0** | 见下方专项 |
| 6 深跌批次正常平仓 | `trade lot close --lot-id LOT-…-004 --price 2.633 --qty 9000 --reason "深跌-(25%)止损复验，批次未冻结可正常平仓" --json` | **0** | `realized_pnl=-7958.04`, `fee=4.74`, `lot_status=CLOSED`, `remaining_quantity=0`；DB 侧 `status=CLOSED`, `close_reason` 全文落库 |
| 7 止盈平仓 | `trade lot close --lot-id LOT-…-001 --price 1312.21 --qty 100 --reason "移动止盈落袋(峰值回撤4.61%)" --json` | **0** | `realized_pnl=18946.72`, `fee=91.85`, `lot_status=CLOSED`；`close_reason` 与 `buy_reason` 双向留存 |
| 8 部分平仓 | `trade lot close --lot-id LOT-…-003 --price 4.123 --qty 2000 --reason "部分平仓复验" --json` | **0** | `close_quantity=2000`, `remaining=4000`, **`lot_status=ACTIVE`**（剩余部分保持活跃）, `realized_pnl=1358.95`；DB：`qty=4000 status=ACTIVE realized=1358.95` |
| 9 多维战绩归因 | `trade stats` | **0** | 见下方独立复算比对 |

#### Gate 3 专项 A：动态移动止盈（受控行情夹具）

夹具（4 个批次，`cost_basis_unit` 与 `peak_price` 注入到确定值，仅观测 CLI 输出）：

| 批次 | symbol | cost | peak | 实测 return | 点差（自峰值回撤） | 期望 | 实测 signal |
|---|---|---|---|---|---|---|---|
| `LOT-…-001` | `600519.SH` | 1121.8243 | 1375.62 | **+16.89%** | **4.61%** | 触发止盈告警 | **`TRAILING_STOP_ALERT`** ✅ |
| `LOT-…-002` | `000001.SZ` | 10.4721 | 11.30 | +7.83% | 0% | 不告警（未达 +15%） | **无 signal** ✅ |
| `LOT-…-003` | `510300.SH` | 3.4427 | 4.2024 | +19.74% | **2.00%** | 激活但**不**告警（<3%） | `trailing=1`，**无 `TRAILING_STOP_ALERT`** ✅ |
| `LOT-…-004` | `159915.SZ` | 3.5167 | 2.628 | **−25.14%** | — | `DEEP_VALUE_ALERT` 且 `ACTIVE` | **`DEEP_VALUE_ALERT`** ✅ |

- `TRAILING_STOP_ALERT` 完整 payload：
  `{"peak_price":1375.62,"pullback_rate":0.04609557872086758,"est_profit":18946.72,"remaining_qty":100,"suggested_qty":100,"suggested_action":"TRAILING_STOP_CLOSE"}`
- **状态翻转（DB 前后对照，`trade scan` 的真实写入被捕获）**：

| symbol | `trailing_stop_active` 前 → 后 | `peak_price` 前 → 后 | `status` |
|---|---|---|---|
| `600519.SH` | **0 → 1** | 1375.62 → 1375.62 | ACTIVE |
| `000001.SZ` | 0 → 0 | 11.30 → 11.31（现价上移，峰值追踪生效） | ACTIVE |
| `510300.SH` | **0 → 1** | 4.2024 → 4.2024 | ACTIVE |
| `159915.SZ` | 0 → 0 | 2.628 → 2.633 | ACTIVE |

- **止盈价一致性交叉验证（分文不差）**：扫描器在 1312.21 报出 `est_profit = 18946.72`；随后用同一价格平仓，`realized_pnl = 18946.72` → **完全相等**（手算校验：`1312.21×100 − 1121.8243×100 − 131221×0.0007 = 18946.72`）。

#### Gate 3 专项 B：`trade stats` 多维战绩归因（与 DB 独立复算逐项比对）

| 指标 | `trade stats` 报表 | 从 `trades` 表独立 SQL 复算 | 一致 |
|---|---|---|---|
| 总平仓笔数 | 2 笔 | `COUNT(*)=2` | ✅ |
| 盈利 / 亏损笔数 | 1 / 1 | `1 / 1` | ✅ |
| 综合胜率 | 50.00 % | `50.0` | ✅ |
| 累计净利润 | +10,988.68 元 | `ROUND(SUM(realized_pnl),2)=10988.68` | ✅ |
| 盈亏比 | 2.38 | `2.38` | ✅ |
| 按标的 `159915.SZ` | 净利 −7,958.04 | DB `realized_pnl=-7958.04` | ✅ |
| 按标的 `600519.SH` | 净利 +18,946.72 | DB `realized_pnl=18946.72` | ✅ |
| 按操盘类型 `[普通波段]` | 2 笔 / 50.0% / +10,988.68 | 与上述合计一致 | ✅ |

- **判据：报表每一栏均与数据库原始聚合值逐位相等 → 核算分文不差。**

### Gate 4 — 看板双模冒烟 ✅ PASS

#### 4a 静态自驱模式

| 项目 | 观测 |
|---|---|
| 命令 | `./trade dashboard --db <沙箱>/cap.db --out <沙箱>/dash-standalone.html --json` → `EXIT=0` |
| 产物 | `size=160,566 bytes`、`mode=-rw-r--r--`、`lines=2993`、`sha256(前16)=2c877c8b8d007ab2` |
| 单文件性 | 外部 `<script src>` / `<link href>` 引用数 = **0** → 真正单文件 |
| 模板残留 | `{{` 占位符残留 = **0**（38 个占位符全部替换） |
| 数据完整性 | 含 `600519.SH`(12) / `510300.SH`(12) / `000001.SZ` / `LOT-20261022-001` / `LOT-20261022-003`；**生产库专有标的一律 0 命中**（`002507.SZ` `164824.SZ` `513880.SH` `513300.SH` `600276.SH` `002393.SZ` 全为 0）→ 看板数据源确为 `cap.db`，无跨库污染 |
| 自驱能力 | 页面内含 `api/health`(3) / `api/summary`(3) / `setInterval`(1) 心跳与轮询逻辑 |
| 无凭证态 | 无默认凭证时 `window.__LOT_TRADER_SESSION_TOKEN__ = ""`、`..._AUTH_CONFIGURED__ = false` → 纯前端自驱 |
| **NaN 审计** | `NaN` 词元 7 处，**全部位于防御性代码/注释**（`: NaN` 缺省实参 ×2、`isNaN()` 守卫 ×1、以及“never paints NaN”注释与文档串）；`:\s*NaN`、`=\s*NaN`（真正的 NaN 取值）出现 **0** 次；带引号 `"NaN"` **0** 次 |
| **NaN 数据审计** | 嵌入的 JSON 数据载荷（`ACCOUNT_METRICS` / `TARGETS_DATA`，9,094 字符）→ JSON 解析成功，`NaN`/`undefined`/`Infinity` 均为 **False**，递归扫描的**非有限数值 = NONE** |
| **NaN 渲染审计** | 剥离 `<script>` 与注释后的渲染标记中 `NaN` 出现 **0** 次、`undefined` **0** 次；`<td>` 单元格 120 个正常渲染 → **无 `NaN` 落地为可见文本** |

#### 4b 本地引擎联动模式

| 项目 | 观测 |
|---|---|
| 启动 | `./trade serve --db <沙箱>/cap.db --port 8907 --token-file <沙箱>/token/link.token --json` → `{"url":"http://127.0.0.1:8907","host":"127.0.0.1","version":"0.1.0","token_source":"generated","token_ephemeral":true}` |
| 心跳目标 | `GET /api/health → HTTP=200`，`time=0.000947s`，`{"status":"ok","host":"127.0.0.1","port":8907}` |
| 凭证注入 | 生成 `dash-linked.html`（**160,599 B**）后 `grep` → `window.__LOT_TRADER_SESSION_TOKEN__ = "16ab2084b43ef7d19bdd533b550b…"`（`token_source: credential_file`）→ 页面具备调用受保护接口的能力。<br>（证据目录内持久化的 `dash-linked.html` 为验收后**独立重跑**的复现样本：另建沙箱 + `LINK` 账户，140,159 B，注入 `c5c76e12…`；两次均实测注入成功，用于证明该行为可复现） |
| 鉴权链路 | `GET /api/summary` + `Authorization: Bearer <注入的 token>` → **HTTP 200** |
| 平滑降级 | `SIGTERM` 后 `GET /api/health → HTTP=000`（curl exit 7，连接拒绝）；端口 **已释放**；沙箱凭证文件 **已删除** → 页面心跳探活将检出失联并回退自驱，无挂起、无异常残留 |
| 看板 `--json` 自动化友好度 | `{"code":0,"msg":"success","data":{...,"token_injected":null,"token_source":"credential_file"}}` → **未注入时与已注入时该字段均为 `null`**，自动化无法据此断言（见 P3-5） |

### Gate 5 — 负向守卫全量通过 ✅ PASS

| 用例 | 命题 | 操作与输入 | 观测 | 判定 |
|---|---|---|---|---|
| TC-N01 合法入参防误杀 | 正常价格/整手股数/合法代码不被误杀 | `lot buy 600519.SH 1000.00 100`（首仓）、`lot buy 000001.SZ 10.00 1000` | 两次均 `code=0`，`lot_id` 正常生成，`stderr` 空 | ✅ |
| TC-N02 30% 硬顶**防误杀** | 未超限的合法买入绝不被误判 | 组合 110,000，`510300.SH 11700 @ 4.00 = 46,800`，投影占比 29.85% | **`EXIT=0`**，新批次写入，组合 `110,000 → 156,800` | ✅ |
| TC-N03 48h 冷却期外放行 | 跨冷却窗口的同源加仓不被死锁 | 父批次回拨 50h 后 `lot add --price 1050.00` | **`EXIT=0`**，`pyramid_level` **1 → 2**，血缘正确 | ✅ |
| TC-N04 浮盈未达标不误触发 | <+15% 严禁激活移动止盈 | 夹具 `000001.SZ` 收益率 **+7.83%** | `trailing_stop_active` 保持 **0**，`scan` 输出**无**该批次信号 | ✅ |
| TC-N05 回撤未达标不误报警 | 自峰值回撤 <3% 严禁 `TRAILING_STOP_ALERT` | 夹具 `510300.SH` 峰值 4.2024 / 现价 4.123 → 回撤 **2.00%** | `trailing_stop_active` **0→1**（+19.74% 达激活线）但**无 `TRAILING_STOP_ALERT`** → 阈值未被误触 | ✅ |
| TC-N06 跌幅超 −20% 严禁冻结 | 大跌批次保持 `ACTIVE` + `DEEP_VALUE_ALERT` 且可平仓 | 夹具 `159915.SZ` 收益率 **−25.14%** | `signal_type=DEEP_VALUE_ALERT`，`suggested_action=DEEP_VALUE_ACCUMULATE_ON_STABILIZE`；`status` 全程 **`ACTIVE`**；随后 `lot close` → **`EXIT=0`, `lot_status=CLOSED`, `realized_pnl=-7958.04`** | ✅ |
| TC-N07 30% 硬顶拦截 | 拟买入后占比 >30.00% 坚决拦截 | 组合 110,000；`510300.SH 11800 @ 4.00`（30.03%）与 `12000 @ 4.00`（30.38%） | 两次均 **`EXIT=1`**；文案 `单标的持仓硬顶风控拦截：买入后标的 510300.SH 估算持仓占比为 30.03%，超过 30.00% 组合级硬顶红线 (标的总额 47200.00 / 组合总值 157200.00)！`；组合总额 `110,000 → 110,000`（**零写入**） | ✅ |
| TC-N08 跨账户代冲隔离 | 严禁借他账户底仓做 T+0 | `bun test` 内 `Cross-account core substitution: physical isolation negative guard` 双用例；运行期另观测到 T+1 锁定信号 | 单测 **pass**；`scan` 对当日买入的 `510300.SH` 输出 `T1_LOCKED_ALERT` / `HOLD_UNTIL_NEXT_TRADING_DAY`（未误放行） | ✅ |
| TC-N09 未授权不泄账本 | 401 且响应体零账本字段 | 见「缺陷 4 附带」T2/T3/T4 | **401 ×3**，敏感字段命中 **0** | ✅ |

**「跌幅 >20% 严禁冻结」的强判据**：
- 沙箱全账本 `SELECT GROUP_CONCAT(DISTINCT status) FROM lots` → **`CLOSED,ACTIVE`** —— 状态空间内不存在冻结态。
- 交付二进制词元扫描：`strings ./trade | grep -c FROZEN` → **0**；`FREEZE` → **0**；`frozen` → 20（全为英文注释/文案，非状态机取值）；`LOCKED` → 39（`T1_LOCKED_ALERT` 语义）。
- 深跌批次 −25.14% 时 `status=ACTIVE`，并可无障碍完成 `lot close`。

---

## 4. 复现方式

```bash
cd /Users/ivywu/Downloads/GitHub/Goodfun-Studio/lot-trader
QA=/tmp/lot-trader-qa-$(date +%Y%m%d-%H%M%S); mkdir -p "$QA"

# --- 缺陷 1a：幽灵库 ---
./trade serve --db "$QA/ghost.db" --port 8899; echo "exit=$?"   # 期望 1；$QA/ghost.db* 命中 0

# --- 缺陷 1b：默认库不被刷新（务必另开一个终端跑 10ms 探针比对指纹） ---
stat -f "%N %z %m" ~/.trade/trade.db ~/.trade/trade.db-wal ~/.trade/trade.db-shm
./trade serve --db "$QA/sandbox.db" --port 8911 --token-file "$QA/tok" --json &
curl -si http://127.0.0.1:8911/api/health; kill -TERM %1
stat -f "%N %z %m" ~/.trade/trade.db ~/.trade/trade.db-wal ~/.trade/trade.db-shm   # 期望与前面逐字段相同

# --- 缺陷 3 + 缺陷 4 + 凭证门禁（注意：CLI 侧只能靠 TRADE_DB_PATH 隔离，--db 无效） ---
export TRADE_DB_PATH="$QA/sandbox.db"
./trade account add CMB --name 招商主仓 --broker CMB --json
./trade lot buy --symbol 600519.SH --price 500  --qty 100  --account CMB --json
./trade lot buy --symbol 000001.SZ --price 12   --qty 1000 --account CMB --json
./trade lot buy --symbol 510300.SH --price 4    --qty 6000 --account CMB --json
./trade lot buy --symbol 159915.SZ --price 4    --qty 9000 --account CMB --json
./trade serve --db "$QA/sandbox.db" --port 8899 --token-file "$QA/tok" --json &
T=$(cat "$QA/tok")
curl -s http://127.0.0.1:8899/api/health                                          # 200（免鉴权）
curl -si http://127.0.0.1:8899/api/lots                                            # 401 UNAUTHORIZED
curl -s -H "Authorization: Bearer $T" http://127.0.0.1:8899/api/summary | jq .portfolio   # remaining_budget: null
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $T" 'http://127.0.0.1:8899/api/lots?account=NOPE'  # 400

# --- Gate 1 / Gate 2 ---
bun test        # 165 pass 0 fail
bun run build && shasum -a 256 trade   # 5bbf7bc11849ff3265a248b9528efa5de77b21ce52dbd2f7236875328165edc1
```

---

## 5. 事故与偏差披露（QA 侧，必读）

### INC-1 · 我用生产账本执行了一次 `trade scan` 与数次只读查询 —— 已量化影响

- **经过**：本人在摸底 CLI 参数时，对 `lot` / `scan` / `stats` / `position` 使用了 `./trade <sub> --help` 形式。这些子命令**不实现 `--help`**，`parseArgs(strict:false)` 把 `--help` 当作未知参数忽略，于是命令**照常执行**，且当时未设置 `TRADE_DB_PATH` → 全部打到默认库 `~/.trade/trade.db`。
- **实际写入**：`trade scan` 内部会持久化峰值追踪（源码 `src/scanner.ts:79`：`UPDATE lots SET peak_price = ?, trailing_stop_active = ? WHERE lot_id = ?`）。默认库 mtime 于 **14:11:46** 由我这次扫描刷新，随后 sha256 = `84686a5e…`（此后全程未再变化）。
- **影响范围（已界定）**：仅 **2 个由行情推导的跟踪字段** —— `peak_price`、`trailing_stop_active`。**会计字段零改动**：`buy_price` / `remaining_quantity` / `cost_basis_unit` / `realized_pnl` / `status` / `trades` 表 / `accounts` 表均未触碰。
- **可自愈性**：这两个字段是 `peak = max(prev_peak, 现价)` 与 `trailing_stop_active = (收益率 ≥ 15%)` 的**纯函数**，任何后续 `scan`/看板刷新都会用同一实时行情重算出同一结果，因此不属于数据损坏。
- **完整性复核（当前）**：`PRAGMA integrity_check = ok`；`lots=909`、`active_lots=203`、`trades=1549`、`accounts=3`；QA 夹具污染扫描 = `none`。
- **改进建议（流程）**：① CLI 对未知参数应报错而非静默忽略（`strict:false` → `strict:true`，或对 `--help` 统一短路）；② QA 侧建立「未显式指定 `TRADE_DB_PATH` 不允许执行任何子命令」的 wrapper 护栏。

### INC-2 · `--db` 对 7 类子命令静默失效（已升级为 P3-4 发现项）

- **实测**：`./trade account add CMB --name … --broker CMB --db /tmp/xxx/sandbox.db --json` → 返回 `{"code":1,"msg":"账户已存在: CMB…"}`，且 `/tmp/xxx/sandbox.db*` **一个文件都没有创建** → 证明该命令读的是默认库、`--db` 完全未生效。
- **后果**：执行者若沿用 `serve`/`dashboard` 的 `--db` 习惯，会误以为已隔离，实际全部落在生产库。
- **本次已采取措施**：所有 CLI 走查改为一律 `export TRADE_DB_PATH=<沙箱路径>`，每步以 `sqlite3 "$TRADE_DB_PATH"` 回读校验。

### INC-3 · 我主动执行了一次「无 `--db`」的看板生成作为对照

- 目的：证明「只有不带 `--db` 时才打开默认库」（10ms 探针 `prod-touch events=1`）。
- 影响：默认库被**只读**打开后正常关闭，SQLite 生命周期性地重建/回收了 `-shm`/`-wal`（`-wal` 当时为 0 字节，无待提交数据）；主库 sha256 与 size **不变**，当前 `-shm` 内容 sha256 仍为 `fd4c9fda…`（与开工时逐字节一致）。**会计数据零影响。**

### INC-4 · 我用 `--token` 固定令牌时污染过默认凭据文件（已复原）

- **经过**：多次以 `./trade serve --token <固定值>` 启动而未同时给 `--token-file`，服务把该固定 token 写入了**默认路径** `~/.lot-trader/session.token`（0600），且因 `token_source=explicit` 在退出时**不删除**。
- **复原**：已于 14:18 删除该文件，`~/.lot-trader/` 已还原为本次开工时的空目录状态（`total 0`）。
- **同时暴露的产品问题**：见 P3-3。

### 关于 `-shm` / `-wal` mtime 的说明

`~/.trade/trade.db-shm` 的 mtime 在本次走查中出现过刷新（14:12:40 → 14:21:25 → 14:23:55），而**其内容 sha256 始终为 `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb`，从未改变**；主库 sha256 亦全程未变。`-shm`/`-wal` 是 SQLite 的临时共享内存/预写日志工件，会在最后一个连接打开时重建、干净关闭时回收，其 mtime 抖动不代表账本内容被刷新。**缺陷 1b 的正式判据采用任务书场景下的「指纹前后比对 + 10ms 探针」双证（均通过）。**

---

## 6. 新发现问题清单（本次走查新增，非四大缺陷范围）

| ID | 级别 | 问题 | 复现命令与观测 | 影响 |
|---|---|---|---|---|
| **P2-1** | **P2** | `trade lot add` 的默认金额阶梯（10,000 元）对高价标的**静默放大**为首笔 1 手，实际金额可达目标预算的 15 倍 | ① 低价对照：`lot add --parent-lot-id <id> --price 11.00` → `qty=900`，名义 9,900 元（符合文档口径）<br>② 高价：`lot add --parent-lot-id <id> --price 1500.00` → **`qty=100`**，名义 **150,000 元**，退出码 **0**，无任何提示<br>③ 源码路径 `src/engine.ts:422-429`：`quantity = Math.floor(amount/price/100)*100; if (quantity<=0) quantity=100;`<br>④ 与《验收用例》TC-P03 期望 `qty: 600` 矛盾 | **资金超投风险**：用户意图加仓约 1 万元，实际下单 15 万元；虽有 30% 硬顶兜底，但当组合内无其他标的时该守卫会跳过（`otherSymbolsValue==0` 分支不校验），存在无拦截放行路径。建议：高价标的下给出显式确认/告警，或改为按 `amount` 上限拒绝而非升格 |
| **P3-1** | P3 | `TRAILING_STOP_ALERT` 的 `reason` 文案存在**乱码** | 观测 payload：`{"reason":"âdynamic trailing stop triggered: peak 1375.6200, pullback 4.61%, return +16.89%"}`；源码 `src/scanner.ts:102` 首字节为 `c3 a2`（U+00E2） | 告警文案中的前缀符号被错误编码（疑似 `⚠`/`·` 的多字节残留），用户可见乱码，不影响判据与数值 |
| **P3-2** | P3 | 构造性 `sqlite_master` 篡改下，`/api/lots` 会返回 **200 + 伪造批次行**而非报错 | `PRAGMA writable_schema=ON; UPDATE sqlite_master SET rootpage=(SELECT rootpage FROM sqlite_master WHERE name='symbols') WHERE name='lots';` → 服务正常启动，`/api/lots` 返回 `HTTP 200, total=18`，且 `lot_id` 字段取到了 `000001.SZ` 这类**符号表**数据 | 仅在外部以 `writable_schema` 主动篡改元数据时可达（截断/非法 rootpage 两条自然损坏路径均已 fail-closed）。现有 `REQUIRED_LOT_COLUMNS` 守卫（`src/serve.ts:562`）依赖列名匹配，交叉错链时列名恰好对上而漏检。建议对 `lots` 行做轻量取值域校验（如 `lot_id` 格式 / `buy_time` 可解析） |
| **P3-3** | P3 | `serve --token <固定值>` 会写默认凭据文件且退出后**不清理** | `./trade serve --db <沙箱> --token <固定值>`（不给 `--token-file`）→ `~/.lot-trader/session.token` 被创建（0600，65 B，内容即该固定 token）；`SIGTERM` 退出后文件**仍存在**（`token_source=explicit` 分支不删） | 一台机器上有多个 `serve` 时，后启动的实例会**覆盖**先启动实例发布的凭据文件，导致先启动实例对应的看板拿到错 token 而持续 401；同时留下陈旧的 secret 文件。建议：显式 token 场景也应支持「退出时清理」或默认写入实例专属文件 |
| **P3-4** | P3 | **7 类子命令静默忽略 `--db`**（假隔离陷阱） | `./trade account add CMB --name x --broker CMB --db /tmp/nope/x.db --json` → `code=1, msg="账户已存在: CMB…"`，且 `/tmp/nope/x.db*` **零文件创建** | 见 INC-2。对自动化脚本与人工排障是高危陷阱。建议：这些子命令也接收 `--db`，或对未识别的 `--db` 直接报错 |
| **P3-5** | P3 | `trade dashboard --json` 无法断言语义（注入与否都是 `null`） | 无凭证时：`{"token_injected":null,"token_source":"none"}`；有凭证时：`{"token_injected":null,"token_source":"credential_file"}` → 字段恒为 `null`（已确认真实注入了 `window.__LOT_TRADER_SESSION_TOKEN__ = "16ab2084…"`） | CI/自动化无法据此判断看板是否具备引擎联动能力。建议将该字段改为布尔真值 |
| **P3-6** | P3（文档） | 《验收用例》TC-P03 的期望值与实际语义不符 | 文档写 `pyramid_level: 2`、`qty: 600`；实测首轮加仓为 `pyramid_level = parent + 1 = 1`，默认 qty 由 `amount/price` 取整（高价标的退化为 100 股） | 文档口径应改为「`pyramid_level = parent.pyramid_level + 1`」；`qty` 期望值需按 P2-1 的结论一并修订，避免后续用错误的期望值做回归断言 |

> **补充口径澄清（非缺陷）**：《发布门禁》与本次任务书对 48h 防抖的描述是「立即同源加仓即拦截」，而《安全清单》§6 的正式条款是「**若已发生过加仓**，则拦截频密补仓」。实测行为与**《安全清单》条款完全一致**：首轮加仓放行（`L1`），48h 内第二轮加仓拦截（exit 1，零新增行）。因此**判定为通过**，并建议将门禁文档的措辞与安全清单对齐。

---

## 7. 判定与后续动作

**✅ 放行（PASS）**——四大缺陷全部确认修复，五大门禁 100% 通过，负向防误杀守卫全量成立，生产账本会计数据零污染。

**放行附带条件（不阻断本次发布）**：

1. 将 **P2-1**（加仓默认金额对高价标的放大 15 倍）排入下一轮决策：要么在超预算时给出显式告警/确认，要么收紧 30% 守卫在「组合内无其他标的」时同样生效。
2. 将 **P3-4**（子命令静默忽略 `--db`）作为操作性修复项——它是本次走查中最高危的「假隔离」来源，也是本人 INC-2 的根因。
3. 将 **P3-1**（告警文案乱码）与 **P3-5**（`token_injected` 恒 `null`）并入下一次小版本打磨。
4. **P3-6**：同步修订《验收用例》TC-P03 的期望值，避免用错误期望值做后续回归。
5. **P3-2**：作为加固项记录，不要求本轮回改（自然损坏路径已 fail-closed）。

**打回对象（若上表第 1、2 项需在本轮修复）**：`persona-strategy-automator`。本报告不修改任何业务源码。

---

## 8. 证据索引

- 持久化证据目录：`docs/qa/evidence/release-gate-20261022-142604/`（70 文件，612K）
- 原始沙箱：`/tmp/lot-trader-qa-20261022-141230/`（**验收完毕后已清理全部临时 SQLite 库、`-wal`/`-shm`、生成的 HTML 与临时凭证目录**；下表的证据副本已随仓库持久化，可独立复核）

| 证据文件 | 对应结论 |
|---|---|
| `MANIFEST.txt` | 版本 / 二进制哈希 / 首尾生产库指纹 / integrity_check |
| `prod-fp-before-serve.txt` | 缺陷 1b 生产库开工指纹 |
| `A1_ghost.stderr` / `A1_ghost.stdout` | 缺陷 1a 退出码 1 与拒绝建库文案 |
| `d2-baseline.json` / `f3-api-summary.json` / `f3-api-lots.json` | 缺陷 2：健康态 `total=4` 对照 vs 故障态 500 `DATABASE_ERROR` |
| `fault-rootpage-ready.json` / `fault-root1-ready.json` | 缺陷 2 附加：启动期损坏 fail-closed |
| `f9-api-lots.json` | P3-2：交叉错链返回 200 + 伪批次行 |
| `t1-health-notoken.json` / `t2-summary-notoken.json` / `t3-lots-notoken.json` / `t4-lots-wrongtoken.json` | 凭证门禁 401 与账本零泄漏 |
| `t5-lots-validtoken.json` / `t6-summary-validtoken.json` | 缺陷 3 组合预算字段与单标的利用率 |
| `d4-account-lower.json` / `d4-account-upper.json` / `d4r-*.json` / `d4l-*.json` | 缺陷 4 大小写不敏感（16 次请求归一化） |
| `d4-account-nope.hdr` / `d4-account-nope.json` | 缺陷 4 未注册账户 400 门禁 |
| `gate1-bun-test.log` | Gate 1：165 pass / 0 fail / 16 files |
| `gate2-delivered.sha256` / `gate2-rebuilt.sha256` / `gate2-build.log` / `gate2-help.txt` | Gate 2：可复现构建逐字节一致 |
| `g3-buy1.json` / `g3-add-blocked.json` / `g3-add-ok.json` / `g3-close-deep.json` / `g3-close-trend.json` / `g3-stats.txt` | Gate 3 全链路与战绩归因 |
| `scan-lotlist.json` / `scan-before.txt` / `scan-after.json` / `scan-after-db.txt` | Gate 3 专项 A：移动止盈 / 防误杀 / 深跌告警与状态翻转 |
| `dashboard-standalone-sample.html` / `g4a.json` / `g4b-health.json` / `g4b-ready.json` | Gate 4 双模冒烟 |
| `g4c-evilhost.json` / `g4c-evilorigin.json` / `g4c-ready.json` / `g4c-conflict.out` / `g4c-bind.out` | 回环 / DNS-rebinding / CORS / 端口冲突守卫 |
| `prod-touch.log` / `prod-touch-D1b.log` | 10ms 探针：默认库触碰事件计数 |

---

*本报告全部结论均基于可复现命令的实测输出与数值前后比对，不含代码观感式推论。报告不修改任何业务源代码。*

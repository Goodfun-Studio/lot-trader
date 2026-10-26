# Lot-Trader L5 全量 E2E 门禁回归报告（放行证据）

- 报告 ID：`release-gate-l5-20261026-commit-c895274`
- 执行角色：`persona-lot-trader-qa`（操盘质检与发布门禁工程师）
- 执行日期：2026-10-26（本地时区 +0800）
- 话题 / 线：`tp-458199de` / `line-qa`（L5 全量 E2E 门禁回归）
- 判定：**产品侧无阻断项 → 建议放行；附 2 项待授权 BLOCKED、1 项既存 flake 待定位**（详见 §9）

### round-2 更新（2026-10-26，本报告已随文档同步提交）

老板批准后，round-2 完成三件事，**下文凡标「round-1」的叙述均为当时事实，与现状不冲突**：

1. **harness 回写隐患已修**：`run-e2e.ts` 改为**默认只跑不改文档**，只有显式 `--write` 才回写 `e2e-test-flow.md`（`--no-writeback` 保留为兼容别名）。验证：不带 `--write` 跑全量后 `git status --porcelain -- docs/qa/e2e-test-flow.md` 为空。
2. **两份文档已同步**：`e2e-test-flow.md` 由 `run-e2e.ts --write` 回写（结果 / 证据路径列 → 119 例）；`user-operation-matrix.md` 按 `l5-doc-drift-proposal-20261026.md` 清单逐条更新（5 处守卫行 / 新增 `G-46` / §14.1 补 6 条修复状态 + 新增 D-10 / §14.2 V-01 / §14.3 解除 2 条并重算为 8 条）。现两份文档跑 checker：`cases=119 pass=116 fail=0 blocked=2 legal_fail=0 pair_na=1 uncovered=0 unpaired=0 evidence_missing=0 blocked_no_reason=0 result_mismatch=0`。
3. **提交范围**：仅 `run-e2e.ts` + 两份文档 + 本报告与变更清单；**未提交任何 `docs/qa/evidence/` 目录**（历史证据目录保持未跟踪）。相应地，本报告引用的证据路径（`docs/qa/evidence/...`）均为**本机未跟踪产物**，克隆后不可直接访问；需要取证时请按 §10 的复跑命令重生。

4. 本轮提交**只 commit、未 push、未打 tag**（老板未授权）；`docs/qa/evidence/` 全部 34 个未跟踪项保持原样（未增减提交范围）。

---

## 1. 被测对象（冻结校验）

| 项 | 值 | 校验方式 |
|---|---|---|
| 仓库 | `/Users/ivywu/Downloads/GitHub/Goodfun-Studio/lot-trader` | — |
| commit | `c895274ffab1c1c586587e56043736ac2aa80ff9`（`c895274 fix(dashboard): D-04 clean output-dir error + D-08 overridable probe base`） | `git rev-parse HEAD` |
| 二进制 | `./trade` | — |
| sha256 | `0447ac7da8f769fe89181eebe7f199e9cd57ba6b577c94cba47017b97cdd64b4` | `shasum -a 256 trade` |
| 大小 / 权限 / 类型 | 63,644,258 字节 / mode 755 / `Mach-O 64-bit executable arm64` | `stat -f`、`file` |
| `--help` 退出码 | `0` | `./trade --help >/dev/null 2>&1; echo $?` |
| 本轮是否重新编译 | **否**。Gate 2 按「冻结产物校验」执行：不 `bun run build`、不改代码 | — |

**与任务书冻结值逐字节一致（sha256 相同）。** 证据：`docs/qa/evidence/tp-458199de-L5-20261026-024927-commit-c895274/gate2-frozen-artifact.txt`

---

## 2. 隔离与生产账本指纹（开工 / 收工逐字节一致）

沙箱根（每条调用都显式带 `--db /tmp/qa-tp-458199de-L5-<ts>/sandbox/db/<名字>.db`、内联 `HOME=<沙箱>/fakehome`、并 `env -u LOT_TRADER_DB -u TRADE_DB_PATH -u LOT_TRADER_TOKEN_FILE`）：

| 轮次 | 沙箱根 | 说明 |
|---|---|---|
| Pass A | `/tmp/qa-tp-458199de-L5-20261026-024450-pA/sandbox` | 未修改 harness 的现状基线（117 例） |
| Pass B | `/tmp/qa-tp-458199de-L5-20261026-024927-pB/sandbox` | 修复判据后的正式第 1 次（119 例） |
| Pass C | `/tmp/qa-tp-458199de-L5-20261026-025046-pC/sandbox` | 正式第 2 次（复核一致性） |

生产账本指纹（Pass B `isolation-start.txt` → `isolation-end.txt`，两文件除时间戳外**逐字节相同**）：

| 对象 | 开工 | 收工 | 判定 |
|---|---|---|---|
| `~/.trade/trade.db` | `1ec361a6474809794841591a5f83bbf042c0159de1536fbed379ce568a2aef59` | 同左 | 未变 |
| `~/.trade/trade.db-wal` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | 同左 | 未变（空） |
| `~/.trade/trade.db-shm` | `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb` | 同左 | 未变 |
| `~/.lot-trader/` | 仅 `session.token.stale-bak`（`-rw-------` 65B，Oct 22 16:32） | 同左 | 未变 |

- 复跑后再次独立复核：`shasum -a 256 ~/.trade/trade.db` = `1ec361a6…aef59`（与开工一致）；`ls -la ~/.lot-trader/` 同左。
- 隔离守卫实弹自检：`harness-guard-violations.txt` 共 **3** 行，全部来自 `E2E-N-01` 的故意违规调用（缺 `--db` / HOME 越界 / `--db` 指生产库），**无一条来自被测用例**。
- 被保护资产哈希在开工/收工快照中逐行一致：`acceptance-cases.md`、`evidence-template.md`、`regression-baseline.md`、`release-gate.md`、`safety-checklist.md`、`reports/release-gate-report-latest.md`（后者在本轮开工前已属「他人未提交改动」状态，sha `428b27a9…72d9e`，本轮未触碰）。
- 端口纪律：全程仅使用 18000–18999（serve 实测端口 18186 等），**未绑定、未探测 8080**（`isolation-start/end` 的 18000–18999 监听清单里没有本轮会话残留）。

---

## 3. 门禁关卡判定总表

| Gate | 判据 | 实测 | 判定 |
|---|---|---|---|
| Gate 1 静态与单元基线 | `bun test` 全绿 | **255 pass / 0 fail / 3191 expect() / 21 files / 39.18s**（另一次 42.87s 同样全绿）；`database is locked` 出现 0 次 | **PASS** |
| Gate 2 单二进制 | 产物存在、可执行、`--help` exit 0 | sha256/大小/权限/类型/`--help`=0 全部符合（§1） | **PASS**（冻结校验，未重编译） |
| Gate 3 沙箱黑盒全流程 | E2E flow 全量实跑 | `cases=119 pass=116 fail=0`（§4） | **PASS** |
| Gate 4 看板双模冒烟 | 静态生成 + 本地引擎联动 | 静态：`E2E-P-16/P-17` PASS（单文件自包含、0600、headless 渲染 >1000 字符、无 NaN）；联动：`E2E-N-97` PASS（顶栏 `class=local` + 文案「本地引擎已联动」，停机后平滑降级 `standalone`）（§6） | **PASS** |
| Gate 5 负向防误杀守卫 | 负向集全通过且 legal 零误杀 | `legal_fail=0`；`unpaired=0`（守卫两侧成对齐全） | **PASS** |

---

## 4. 全量汇总行与两次连跑一致性

`bun docs/qa/tools/check-e2e-flow.ts` 汇总行（对**当前** `e2e-test-flow.md` + 本轮 results.json）：

```
cases=117 pass=104 fail=8 blocked=4 legal_fail=0 pair_na=1 uncovered=0 unpaired=0 evidence_missing=0 blocked_no_reason=0 result_mismatch=12
```

（round-1 状态：`result_mismatch=12` = 8 条前序 FAIL + N-96/N-97 两条 BLOCKED 已转 PASS + 2 条新增用例尚未进文档；当时文档结果列仍是 2026-10-24 的旧值。**round-2 已回写文档，现为 `result_mismatch=0`，见本报告开头的「round-2 更新」。**）

对**提议版**文档（`proposed-e2e-test-flow.md`，仅结果列 / 受影响行 + 2 条新行，产物随报告附上）：

```
cases=119 pass=116 fail=0 blocked=2 legal_fail=0 pair_na=1 uncovered=0 unpaired=0 evidence_missing=0 blocked_no_reason=0 result_mismatch=0
```

两次实跑（Pass B / Pass C，同二进制同 harness）逐用例比对：

```
DIFF (id, B, C): NONE — 两次 (用例 ID, 结果) 完全一致
B summary {'total': 119, 'pass': 116, 'fail': 0, 'blocked': 2, 'legal_fail': 0, 'pair_na': 1}
C summary {'total': 119, 'pass': 116, 'fail': 0, 'blocked': 2, 'legal_fail': 0, 'pair_na': 1}
tradeSha256 0447ac7d…d64b4 / commit c895274ffab1c1c586587e56043736ac2aa80ff9 / elapsed 69.4s / 68.4s
```

- `blocked=2` = `E2E-N-04` / `E2E-N-05`（G-03 环境变量与默认库路径优先级），阻塞原因与产品改动无关：需要一次**不带 `--db`** 的调用，与硬性隔离铁律冲突，非授权不可执行。
- `pair_na=1` = `E2E-N-85`（G-42 性质断言，无违规侧可构造，原文档已写明原因）。

---

## 5. 前序 8 项 FAIL 的转 PASS 逐条证据

> **必须先读的结论**：8 项中有 **5 项（N-88/90/92/93/95）** 是产品已修好、直接转 PASS；
> **另外 3 项（N-41/65/94）** 在产品侧**本来就已经合规**，原写死的判据与产品契约不符，属**判据失真**：
> - `E2E-N-41`：断言要求拦截文案含「防抖／48」，而 D-01 的修法是「冷却改用真实时钟 + 新增『成交时间不得晚于当前』守卫」，
>   未来时间走的是后者的文案；
> - `E2E-N-94`：harness 自己用 `dataOf()`（该 helper 内置 `code=0` 断言）去解析一个**必须失败**的调用，与用例判据自相矛盾（harness bug）；
> - `E2E-N-65`：用例写死了 D-02 修复**前**的 help 示例键 `{"add":-0.1,"take":0.1}`，D-07 生效后被合法拒绝。
>
> 这三项的**实质安全属性**在修复判据前就已经满足，证据见下表 Pass A 列（未改动 harness 的现状基线）。
> 判据修复已按最小改动落地（§9.1），修复后三项均 PASS；`proposed` 文档里这三行的「预期」列同步改写为可证伪的新表述。

| 用例 | 判据要点 | Pass A（未改判据） | 修复后（Pass B/C） | 关键实测 |
|---|---|---|---|---|
| `E2E-N-41`（D-01 未来时间绕过） | `lot add --time <未来>` exit≠0 且零写入 | exit=1、六表 Δ=0 ✅；仅文案断言 NG | **PASS** | 未来值 `2026-10-27T20:45:20Z` → exit **1**，`lots 2→2`、`trades 2→2`；文案「成交时间不得晚于当前时间：…传入 2026-10-27T20:45:20.000Z 晚于当前 2026-10-25T18:45:20.315Z，已拒绝写入账本」。对照：旧证据同一命令 exit `0`、`lots 2→3`、`trades 2→3`（真缺陷已消失） |
| `E2E-N-65`（D-02 help 示例键） | 照抄 `scan --help` 示例必须生效 | 示例取的是旧键集合 → exit=1 | **PASS** | `scan --help` 现声明「Keys are exactly the ones the scanner reads」并给示例 `{"take_profit_min":0.05,"dip_1":-0.08}`；照抄该示例 → exit **0** 且命中 `TAKE_PROFIT_ALERT`；旧键 `{"add":-0.1,"take":0.1}` → exit **1**（D-07 校验生效，键集已与实现一致） |
| `E2E-N-88`（D-07 非法阈值） | 非法 JSON / 非法取值均 exit≠0 | PASS | **PASS** | `--thresholds not-json` → exit **1**；`--thresholds {"take_profit_min":"high"}` → exit **1**；两次 Δ 全 0 |
| `E2E-N-90`（D-09 非法价格） | `abc` / `0` / `-2.5` 三次都拒 | PASS | **PASS** | 三次 exit **1**、六表 Δ=0、`库内不得出现非法价格 bad_rows=0` |
| `E2E-N-92`（D-03 未声明参数） | `dividend add --ex-date` 必须报错且零写入 | PASS | **PASS** | exit **1**，`dividends_rows=0`，文案「未声明的参数 --ex-date（命令: trade dividend add）…」 |
| `E2E-N-93`（D-04 无 Traceback） | 输出目录不存在 → exit≠0 且无解释器堆栈 | PASS | **PASS** | exit **1**、六表 Δ=0、`不得抛出未捕获堆栈 matched=false` |
| `E2E-N-94`（D-05 非法天数） | `stats --days abc` exit≠0 且不清空报表 | exit=1、Δ=0、报表未被清空 ✅；仅 harness 的 `code=0` helper 断言 NG | **PASS** | exit **1**；默认窗口 `total_trades=1` → 非法天数调用后报表仍为 1 笔（未被清空）；文案「--days 必须是合法数值字面量…」 |
| `E2E-N-95`（D-06 文案精度） | 占比与阈值可区分 | PASS | **PASS** | exit **1**、六表 Δ=0；文案「估算持仓占比为 **30.0010%**，超过 **30.00%** 组合级硬顶红线 (标的总额 3000.10 / 组合总值 10000.00)」→ `ratio=30.0010 ≠ threshold=30.00` |

逐条原始断言与命令见证据目录 `<CASE>.json` / `<CASE>.rows.md`。
**Pass A（未修改判据的现状基线）证据已归档**：`docs/qa/evidence/tp-458199de-L5-20261026-024927-commit-c895274/passA-baseline-asis-harness/`（含 `results.json` 汇总 = `pass 106 / fail 6 / blocked 4 / legal_fail 1` 与上表 13 条相关用例的逐条断言）；与之配套的未修复 harness 原件为同目录 `run-e2e.pre-repair.ts`（sha256 `bc89b003…d02176`，与 Pass A 运行时逐字节一致）。Pass C 结果另存 `results-passC.json` 供两次一致性核对。

---

## 6. D-08 解阻：`E2E-N-96` / `E2E-N-97` 从 BLOCKED 转可判定

原阻塞原因（矩阵 §14.3 `SERVE-8080-LINKED` / `SERVE-DUAL-MODE-GREENLIGHT`）：看板探活地址写死 8080，而本话题端口边界禁用 8080。
`trade dashboard --api-base <url>` 落地后该能力缺口消除，两项按新判据实跑：

**`E2E-N-96`（探活基址可覆盖）— PASS**

| 观测点 | 实测 |
|---|---|
| `dashboard --help` | 声明 `--api-base URL`（文案含「Pass the address `trade serve` is actually listening on」） |
| 生成命令 | `./trade dashboard --out …/n96-dash.html --token n96-token-… --api-base http://127.0.0.1:18436 --json` → exit **0**，六表 Δ=0 |
| 产物探活基址 | `LOCAL_API_BASE = 'http://127.0.0.1:18436'`（= 传入值；**不再是 8080**） |
| 残留 8080 字样 | 仅说明文本与注释（非探活目标），已计入取证文件 |

**`E2E-N-97`（双模联动转绿 / 停机平滑降级）— PASS**

| 步骤 | 命令/操作 | 停机前 | 停机后 |
|---|---|---|---|
| 起引擎 | `trade serve`（沙箱内，端口 18186，`--token-file` 沙箱路径） | `/api/health` = 200（`healthOk=true`） | — |
| 生成看板 | `trade dashboard --out …/n97-dual-mode.html --token-file <沙箱凭据> --api-base http://127.0.0.1:18186 --json` | exit **0**，产物 `LOCAL_API_BASE='http://127.0.0.1:18186'` | — |
| headless 浏览器读 DOM（同页 `file://`） | Chrome `--headless=new --virtual-time-budget=9000 --dump-dom` | 顶栏 `class="mode-indicator **local**"`、文案「模式：**本地引擎已联动**」、`live-status`「**本地引擎行情** • 非交易时段 • 休眠降频 60s」、DOM 139,705 字节、渲染文本 NaN 命中 **0** | 顶栏 `class="mode-indicator **standalone**"`、文案「模式：轻量独立（纯前端自驱）」、DOM 139,673 字节、NaN 命中 **0**（非白屏、无 NaN） |
| 停机 | `SIGTERM` | — | exit **0**，端口 18186 3 秒内释放 |

结论：**本项不再 BLOCKED**，且是在 18000–18999 端口（18186）上完成的联动转绿验证，全程未使用 8080、未使用 `--port 0`、未伪造页面探活地址。

---

## 7. 新增 D-10 用例（`--fee` / `--qty` 字面量守卫，成对）

| 用例 | kind | 判据 | 实测 |
|---|---|---|---|
| `E2E-N-100` | violation | `--fee abc` / `--qty abc` exit≠0 + 零写入 + 文案指明数值字面量 | `--fee abc` → exit **1**，六表 Δ=0，文案「--fee 必须是合法数值字面量（禁止千分位逗号 / 单位后缀 / 下划线 / 十六进制），收到: abc」；`--qty abc` → exit **1**，六表 Δ=0，同构文案 |
| `E2E-P-19` | legal | `--fee 0` / `--fee 5.5` / `--qty 100` exit 0 且 `cost_basis_unit` 有限正数 | `--fee 0` → exit **0**、`lots +1`、`cost_basis_unit=8.199`；`--fee 5.5` → exit **0**、`lots +1`、`cost_basis_unit=8.254`（= `8.199 + 5.5/100`，判据 `price + fee/qty` 命中）；`--qty 100` → exit **0**、`lots +1`、`cost_basis_unit=8.199` |

两项已进入 harness 用例表（`docs/qa/tools/run-e2e.ts`，stage 2），两次实跑均 PASS。

---

## 8. legal 侧零误杀声明与「已确认口径」复核

- **最终两次实跑 `legal_fail=0`，`pair_na=1`（G-42 性质断言，原文档已写明原因），`unpaired=0`。**
- Pass A（未改判据的现状基线）曾出现 **1 条 legal FAIL：`E2E-N-56`**。已定位为**用例缺陷，不是产品误杀**，证据链如下：
  1. `./trade lot buy --help` 声明的理由旗标是 `--reason`，**没有 `--buy-reason`**；`--buy-reason` 只属于 `lot edit`（`./trade lot edit --help`）。
  2. 该用例（及其配对 `E2E-N-55`）在**建仓步骤**错误地传了 `--buy-reason`。K-03 裁定（2026-10-24）要求未声明参数必须报错，D-03 落地后该命令被拒：`{"code":1,"msg":"未声明的参数 --buy-reason（命令: trade lot buy）…"}`，exit **1**、六表 Δ=0 —— 产品行为与 help 契约一致。
  3. 旧证据显示这两条用例此前是**靠 D-03 的静默忽略才「通过」**：2026-10-24 的 `E2E-N-55.json` 断言为 `buy_reason 在原值上追加 | before= after=appended-thesis`（追加前是空串，断言被弱化成恒真）；`E2E-N-56.json` 的行快照为 `LOT-20261024-001|ACC||518880.SH|…`（`buy_reason` 为空）——即当时的建仓理由根本没落库。
  4. 判据修复（改用 `--reason`）后：建仓 exit 0，`lot edit --lot-id … --buy-reason appended-thesis --append` → exit 0，`buy_reason` 由 `original-thesis` 变为 `original-thesis\nappended-thesis`，`cost_basis_unit|status|remaining_quantity|realized_pnl` = `8.199|ACTIVE|100|0` **零漂移**；`E2E-N-55/56` 双双 PASS。
  5. 顺带把该契约钉进用例：`E2E-N-55` 现在显式断言 `lot buy --buy-reason` 必须被拒且零写入。
- 任务书点名的「已确认口径」逐条复核（均按正确行为记录，未记 legal FAIL）：
  - `stats --days 7.0` → exit **0**；`stats --days 1e3` → exit **0**；`stats --days abc` → exit **1**（等价天数被接受、非数值被拒）；
  - `lot close --qty 1` / `--qty 150`：实测部分平仓放行，`remaining_quantity` 由 200 → 199 → 49（不强制整百，与 `substitute_core_quota.test.ts` 口径一致）；
  - `--price 1e3` / `--fee 1e3` / `--days 1e3` 被接受属正确行为（科学计数法字面量为合法数值）。
  - 上述 `--days` 接受集**没有任何 E2E 用例或文档条目断言它们应被拒**，故无「文档过时」需按此口径改写（`--days 7.0` / `1e3` 目前无对应用例）。

---

## 9. 偏差、载荷与待办（诚实优先）

### 9.1 harness 判据修复清单（`docs/qa/tools/run-e2e.ts`，**待评审**）
文件哈希：`bc89b003…d02176`（Pass A 使用）→ `f5b9032f…cbc782`（Pass B/C）；`+163 / −31` 行；完整 diff 见证据目录 `harness-repairs.diff`。
每一项都是**判据与契约对齐**，不含放宽安全属性：

| # | 用例 | 改动 | 依据 |
|---|---|---|---|
| 1 | — | `EXPECTED_TRADE_SHA` 常量刷新为本轮冻结二进制的 sha256 | 隔离快照里该项此前记为 `matches=false`（写死旧二进制哈希），属 harness 自身失真 |
| 2 | `E2E-N-41` | 文案断言放宽为「成交时间晚于当前 / 冷却窗口」二者之一 | D-01 修法（矩阵 §14.1 D-01 修复状态原文） |
| 3 | `E2E-N-43` | 股数文案断言补「必须为正整数股数」 | 实测新文案 |
| 4 | `E2E-N-55/56` | 建仓旗标 `--buy-reason` → `--reason`；并在 N-55 增补「未声明参数必须被拒」断言 | `lot buy --help` / K-03 |
| 5 | `E2E-N-65` | 示例键改为**现场从 `scan --help` 提取**，并新增「旧键必须被拒」断言 | D-02 判据「help 示例必须可用」本身不变，改为自更新以免再次过期 |
| 6 | `E2E-N-94` | 去掉对「必须失败调用」的 `code=0` JSON helper 断言，改用宽松解析 | 原写法与用例判据自相矛盾（harness bug） |
| 7 | `E2E-N-96/97` | 从硬编码 `c.block(...)` 改写为真断言（探活基址覆盖 / 双模联动转绿 + 停机降级） | D-08 已修，缺失能力消失 |
| 8 | 新增 | `E2E-N-100`（violation）+ `E2E-P-19`（legal） | D-10 无既有用例 |

### 9.2 仍 BLOCKED（需授权，2 项）
`E2E-N-04` / `E2E-N-05`（G-03：`--db > $LOT_TRADER_DB > $TRADE_DB_PATH > 默认路径` 的优先级）：需要一次**不传 `--db`** 的调用，与「每条调用必须显式带沙箱 `--db`」的铁律冲突；默认路径一级还会解析到生产账本，本话题禁止触碰。**缺的能力**：授权一次「HOME 与三个环境变量全部重定向到沙箱、不传 `--db`」的观测；或该观测由不设隔离铁律的线（L1）承担。

### 9.3 既存 flake（**非本话题回归**，但未定位到根因）
- 事实：`bun test tests/dashboard.test.ts` 单文件连跑 **31 次，5 次失败（≈16%）**，失败签名均为 `4 pass / 1 fail`；捕获到的现场为 `tests/dashboard.test.ts:177` → `bun run src/cli.ts dashboard --out … --json` 退出码 **1**（期望 0），测试**未打印子进程 stderr**，故根因文本不可见。
- 未能复现的场合：完整 `bun test`（255 例）1 次全绿、`database is locked` 出现 0 次；按同序（buy → 原始 SQL fixtures → dashboard）的 CLI 级复跑 **60/60 通过**；忠实重放同一 in-process `AppDatabase` + 子进程序列 **40/40 通过**（该重放会把子进程 stderr 打出来）。
- 判定：与任务书点名的既存 flake（`src/db.ts:149` WAL race）**属同一现象族**，但**我没有亲自观测到 `database is locked` 字样**，因此不将其记为产品回归，也不声称已定根因。**建议**：让该用例在失败时输出 `res.stderr`（观测能力缺口），再复跑 30+ 次以取根因文本。

### 9.4 文档失真清单
见随本报告附上的 [`l5-doc-drift-proposal-20261026.md`](./l5-doc-drift-proposal-20261026.md)（`docs/qa/e2e-test-flow.md` 与 `docs/qa/user-operation-matrix.md` 的逐条「文件 + 行号 + 原描述 + 应改成什么」）。
**round-1 按任务书要求未直接修改这两个文档**（round-2 已经批准实施，本文件亦已随之改为「已实施」，保留为每处改动的依据与理由）。另附可直接 diff 的提议版 flow md：`docs/qa/evidence/tp-458199de-L5-20261026-024927-commit-c895274/proposed-e2e-test-flow.md`（在该副本上跑 checker 得 `result_mismatch=0`）。

### 9.5 其他如实记录
- 证据**路径重定位**：本轮的 `--out` 指向话题规定的 `/tmp/qa-tp-458199de-L5-<ts>/`，因此 `results.json` 内的证据路径原本是 `/tmp` 绝对路径（harness 仅在默认 `--out` 下写仓库相对路径）。为让证据在仓库内可解析，复制进仓库时**只改写了证据数组的路径前缀**，并把未改动的原件另存为 `results.json.raw-tmp-paths.json`（3349 条路径重写，逐条可核）。运行期数据（退出码、行数、stdout/stderr、DOM、断言）**未做任何改写**。
- round-1 **未回写** `e2e-test-flow.md`（任务书要求不动这两份文档），因此当时 checker 对当前文档报 `result_mismatch=12`；**round-2 已回写并复跑 checker 得 `result_mismatch=0`**。
- round-1 **未** merge / build / commit / push；`git status --porcelain -- src tests scripts` 为空（业务代码零改动）。round-2 已 commit（仅 5 个 QA 文件，未 push、未打 tag）。
- 收工清理：三个 `/tmp/qa-tp-458199de-L5-*` 运行目录（含各自 `sandbox` 与 `results.json`）与探针沙箱 `/tmp/qa-l5-probe`、`/tmp/qa-l5-explore`、`/tmp/qa-l5-flake-repro` 已删除；Pass A / B / C 的全部证据与隔离快照已先行落到仓库内 `docs/qa/evidence/tp-458199de-L5-20261026-024927-commit-c895274/`，删除后 `results.json` 引用的证据路径全部指向仓库内文件（`evidence_missing=0` 可复核）。

---

## 10. 复跑命令（可逐条重放）

```bash
cd /Users/ivywu/Downloads/GitHub/Goodfun-Studio/lot-trader

# §1 冻结校验
shasum -a 256 trade            # 期望 0447ac7d…d64b4
git rev-parse HEAD             # 期望 c895274ffab1c1c586587e56043736ac2aa80ff9

# Gate 1
bun test

# Gate 3/4/5：全量 E2E（两次）—— 默认只跑不改文档
TS=$(date +%Y%m%d-%H%M%S)
bun docs/qa/tools/run-e2e.ts --out /tmp/qa-tp-458199de-L5-$TS     # 期望 total=119 pass=116 fail=0 blocked=2 legal_fail=0 pair_na=1
# 需要同步 e2e-test-flow.md 结果列时（仅全量运行有效）：
bun docs/qa/tools/run-e2e.ts --write
diff <(python3 -c "import json;print(json.dumps({k:v['result'] for k,v in json.load(open('/tmp/qa-tp-458199de-L5-<ts1>/results.json'))['cases'].items()},sort_keys=True,indent=1))") \
     <(python3 -c "import json;print(json.dumps({k:v['result'] for k,v in json.load(open('/tmp/qa-tp-458199de-L5-<ts2>/results.json'))['cases'].items()},sort_keys=True,indent=1))")
# 期望空 diff（两次 (用例 ID, 结果) 完全一致）

# 汇总行
bun docs/qa/tools/check-e2e-flow.ts --results docs/qa/evidence/tp-458199de-L5-20261026-024927-commit-c895274/results.json
bun docs/qa/tools/check-e2e-flow.ts --flow docs/qa/evidence/tp-458199de-L5-20261026-024927-commit-c895274/proposed-e2e-test-flow.md \
                                   --results docs/qa/evidence/tp-458199de-L5-20261026-024927-commit-c895274/results.json   # 期望 result_mismatch=0

# 收工指纹比对
shasum -a 256 ~/.trade/trade.db    # 期望 1ec361a6…aef59（与开工一致）
ls -la ~/.lot-trader/              # 期望仅 session.token.stale-bak
```

---

## 11. 附：证据索引（`docs/qa/evidence/tp-458199de-L5-20261026-024927-commit-c895274/`）

| 文件 | 内容 |
|---|---|
| `isolation-start.txt` / `isolation-end.txt` | 开工/收工隔离快照（生产账本三件套 sha、`~/.lot-trader` 清单、被保护文档 sha、18000–18999 监听、git status） |
| `results.json` | 119 例逐条结果 + 断言 + 步骤（证据路径已重定位） |
| `results-passC.json` | 第 2 次实跑（Pass C）的逐条结果，用于两次一致性比对 |
| `passA-baseline-asis-harness/` | 未修改判据时的现状基线（Pass A）：`results.json` + 13 条相关用例断言 + 隔离快照 |
| `run-e2e.pre-repair.ts` | 修复前的 harness 原件（sha256 `bc89b003…d02176`），与 Pass A 运行时逐字节一致 |
| `results.json.raw-tmp-paths.json` | 完全相同内容的原件（证据路径为 /tmp 绝对路径），供重定位审计 |
| `gate1-bun-test-full.log` | Gate 1 全量测试完整日志（255 pass / 0 fail） |
| `gate2-frozen-artifact.txt` | 冻结二进制 sha/大小/权限/类型/`--help` 退出码与 commit |
| `harness-repairs.diff` | §9.1 判据修复的完整 diff |
| `proposed-e2e-test-flow.md` | 提议版 flow md（仅结果列/受影响行/新行，可直接 diff 采用） |
| `flake-probe-dashboard-test.txt` / `flake-probe-dashboard-test-failure*.log` | §9.3 flake 观测与失败现场 |
| `flake-probe-dashboard-replay.log` | 忠实重放 40/40 通过的记录 |
| `<CASE>.json` / `<CASE>.rows.md` / `<CASE>__<n>.{cmd,stdout,stderr,exit}` | 逐用例断言、逐表行数前后变化、逐步命令与三流原始输出 |
| `harness-guard-violations.txt` | 隔离守卫拒绝记录（仅 3 条 `E2E-N-01` 故意违规自检） |
| `E2E-N-96__probe-base-forensics.txt`、`E2E-N-97__browser-dom-linked.html`、`E2E-N-97__browser-dom-after-stop.html`、`E2E-N-97__browser-screenshot-linked.png` | D-08 / 双模联动的产物与浏览器取证 |

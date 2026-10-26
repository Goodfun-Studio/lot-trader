# L5 文档失真清单与更新记录（**已按批准实施**）

- 报告 ID：`l5-doc-drift-proposal-20261026`
- 执行角色：`persona-lot-trader-qa`
- 触发：L5 全量 E2E 门禁回归（commit `c895274`，二进制 sha256 `0447ac7d…d64b4`）
- 关联报告：[`release-gate-l5-20261026-commit-c895274.md`](./release-gate-l5-20261026-commit-c895274.md)

> **状态：本清单已于 round-2 经老板批准后实施**：`e2e-test-flow.md` 由 `run-e2e.ts --write` 回写结果列，`user-operation-matrix.md` 按 §B 逐条手工更新；两份文档跑 checker 现为 `result_mismatch=0 · uncovered=0 · evidence_missing=0 · unpaired=0`。
> 本文件保留为**「每处文档改动的依据与理由」的存档**，不再代表未完成状态。
> 追溯（round-1 原状）：本清单当时只提案、未改动任何一份文档；`docs/qa/e2e-test-flow.md` 与 `docs/qa/user-operation-matrix.md` 属 QA 资产，改动需经批准。
> 可直接 diff 的提议版 flow md（round-1 产物）仍在证据目录：
> `docs/qa/evidence/tp-458199de-L5-20261026-024927-commit-c895274/proposed-e2e-test-flow.md`
> （在该副本上跑 checker：`cases=119 pass=116 fail=0 blocked=2 legal_fail=0 pair_na=1 uncovered=0 unpaired=0 evidence_missing=0 blocked_no_reason=0 result_mismatch=0`）

## 0. 失真成因（三类，处理方式不同）

| 类别 | 成因 | 处理方式 |
|---|---|---|
| ① 派生列过期 | flow md 的「步骤命令 / 预期 / 预期值来源 / 结果 / 证据路径」五列**由 runner 回写**（见 flow md 第 9 行）；本轮按任务书要求未回写，故仍停留在 2026-10-24 的值 | 批准后把 R1–R8 判据修复合入 `run-e2e.ts` 并回写一次即可（机械） |
| ② 预期文本与产品契约不符 | 8 项前序 FAIL 里有 3 项（N-41/65/94）是**判据失真**，另有 2 项（N-55/56）用例本身用错旗标 | 随 ① 一起回写（判据文本已在 runner 内改好）；`user-operation-matrix.md` §11/§14.1 的**人工正文**需按 §B 逐条改 |
| ③ 章节正文陈旧 | §5 缺陷覆盖矩阵、§7 BLOCKED、§14.1 修复状态、§14.2 观测、§14.3 缺失能力等**人工撰写的正文** | 需人工改，逐条见下 |

---

## A. `docs/qa/e2e-test-flow.md`

### A-1 派生列（类别 ①）——建议整体回写，不必逐行手改

- **行 9**（原文）：`> 「结果 / 证据路径」两列由 run-e2e.ts 在实跑结束后依据 results.json 回写（<!-- CASE-TABLE-STAGE-N --> 区间），不得手填。`
  **应改成**（补充本轮的一次例外，避免下次核对时误判）：
  `> 「步骤命令 / 预期 / 预期值来源 / 结果 / 证据路径」五列由 run-e2e.ts 在实跑结束后依据 results.json 与 runner 内的用例定义回写（<!-- CASE-TABLE-STAGE-N --> 区间），不得手填。L5（commit c895274）为遵守「QA 文档改动需经批准」，以 --no-writeback 运行，结果存于 docs/qa/reports/release-gate-l5-20261026-commit-c895274.md 与随附的 proposed-e2e-test-flow.md。`

### A-2 预期/来源列与结果列发生实质变化的行（类别 ②③）

| 行号 | 用例 | 原描述（关键部分） | 应改成 |
|---|---|---|---|
| 152 | `E2E-N-41` | 预期：`…必须仍被拦截（exit≠0 · lots 不变）；现状被放行即 FAIL（缺陷 D-01）`；结果 `FAIL` | 预期：`链上已有近期加仓时，把本次加仓 --time 写成未来值必须仍被拦截（exit≠0 · lots/trades 零变化）；文案指出拦截原因（冷却窗口或成交时间晚于当前）`；结果 `PASS` |
| 154 | `E2E-N-43` | 预期：`…文案含「100 的整数倍」或「必须大于 0」` | 预期：`…文案说明股数约束（「100 股整数倍」或「必须为正整数股数」）`（实测文案：`--qty 必须是 100 股整数倍（一手 = 100 股），收到: 150 股` / `--qty 必须为正整数股数（单位: 股），收到: 0`） |
| 166 | `E2E-N-55` | 预期：`exit 0 · 各表行数 0 变化 · buy_reason = 原值+追加值 …` | 预期：`` `lot buy --buy-reason` 属未声明参数必须 exit≠0 且零写入（--buy-reason 只属于 `lot edit`）· 建仓用 --reason exit 0 · edit --append exit 0 · 各表行数 0 变化 · buy_reason = 原值+追加值 · cost_basis_unit/status/remaining_quantity/realized_pnl 零漂移 ``；来源列补 `./trade lot buy --help（建仓侧的理由旗标是 --reason）` |
| 167 | `E2E-N-56` | 预期：`exit≠0 · 各表行数 0 变化 · 全部会计/状态/理由字段逐字节不变 · 文案提示 Missing reason` | 同上口径；来源列补 `./trade lot buy --help（--reason）`；结果 `PASS`（旧值曾因用例误用 `--buy-reason` 而在 L5 现状基线里落到 legal FAIL） |
| 176 | `E2E-N-65` | 预期：`+10% 批次在默认阈值下无信号；按 help 示例键覆盖后必须命中止盈信号…`；来源：`./trade scan --help（Override signal thresholds, e.g. '{"add":-0.1,"take":0.1}'）…` | 预期改为「示例键**现场从 `scan --help` 提取**后照抄必须生效；D-02 修复前 help 里的旧键 `{"add":…,"take":…}` 必须被拒（D-07）」；来源：`./trade scan --help（Keys are exactly the ones the scanner reads … Example: '{"take_profit_min":0.05,"dip_1":-0.08}'）`；结果 `PASS` |
| 219 | `E2E-N-94` | 预期：`…（现状 exit 0 且零笔 → FAIL，缺陷 D-05 复现）` | 预期去掉「现状…」括号（D-05 已修）；结果 `PASS` |
| 221 | `E2E-N-96` | 预期：`BLOCKED · 话题边界禁止使用 8080 …缺失能力：允许绑定 8080 的授权，或修复 D-08…`；来源：`./trade dashboard --help（无 port/base-url 参数）`；结果 `BLOCKED` | 预期：`dashboard --help 声明 --api-base · 产物内绑定探活基址的本地常量等于传入值（不再写死 8080）· exit 0 · 各表行数 0 变化`；来源：`./trade dashboard --help（--api-base URL）；矩阵 §14.1 D-08 / §14.3 SERVE-8080-LINKED`；结果 `PASS` |
| 223 | `E2E-N-97` | 预期：`BLOCKED · 缺失能力：需要绑定看板写死的探活端口…或先修复缺陷 D-08`；步骤 `—`；结果 `BLOCKED` | 预期：`serve 在 18000-18999 端口就绪后，页面顶栏指示灯 class=local 且文案「本地引擎已联动」· 停机后重载同一页面平滑降级为 standalone（非白屏、无 NaN）· 停机 exit 0 且端口释放`；来源补 `矩阵 §14.3 SERVE-DUAL-MODE-GREENLIGHT（缺失能力由 --api-base 补齐）`；结果 `PASS` |
| 203–204 | 新增 | （原文档无此行） | 新增 `E2E-N-100`（violation，D-10：`--fee abc` / `--qty abc` exit≠0 + 零写入 + 数值字面量文案）与 `E2E-P-19`（legal，D-10：`--fee 0` / `--fee 5.5` / `--qty 100` exit 0 且 `cost_basis_unit` 有限正数），均归 stage 2 |

> 其余 111 行的「步骤命令 / 结果 / 证据路径」只是**指针与沙箱路径变化**（L5 沙箱 `/tmp/qa-tp-458199de-L5-…`），内容按 A-1 一次回写即可。

### A-3 章节正文（类别 ③）

| 行号 | 原描述（关键部分） | 应改成 |
|---|---|---|
| 207–208 | `缺陷回归覆盖矩阵缺陷表全部条目：D-01（E2E-N-41）… D-09（E2E-N-90）。` | 补 `D-10（E2E-N-100 / E2E-P-19，本轮核验新增：--fee / --qty 字面量守卫）`；并把 9 条的状态写成「L5（commit c895274）全部转 PASS」 |
| 210–211 | `…实测仍宽松即如实记 FAIL。D-08 仍因话题端口边界（禁用 8080）保持能力缺失型 BLOCKED。` | 改为：`D-03 / D-05 / D-06 在 K-03/K-04/K-05 裁定后按裁定写预期；L5 实测三条均已按裁定修复（exit≠0 + 零写入 + 文案达标）。D-08 已修复（trade dashboard --api-base），E2E-N-96/97 从 BLOCKED 转为可判定并在 18000–18999 端口内完成联动转绿验证，不再存在能力缺失型 BLOCKED。` |
| 254（§7 B-02 行） | `B-02 \| E2E-N-96 / E2E-N-97（D-08 看板写死探活地址 / 联动转绿） \| 缺「允许绑定…8080 的授权」或「修复 D-08…」…` | 删除该行；§7 标题（247 行）由「能力缺失型 BLOCKED（仅 2 类，逐条写明缺什么）」改为「能力缺失型 BLOCKED（仅 1 类：B-01）」，并注明 B-02 已由 D-08 修复解除（L5 证据 §6） |
| 256–260（§8 汇总与判定） | 只有汇总行格式说明 | 追加本轮实测汇总行，作为下一轮的对照基线：`L5（commit c895274，二进制 0447ac7d…d64b4）：cases=119 pass=116 fail=0 blocked=2 legal_fail=0 pair_na=1 uncovered=0 unpaired=0 evidence_missing=0 blocked_no_reason=0 result_mismatch=0（对 proposed 版本；对当前文档为 result_mismatch=12，因未回写）` |
| 228–246（§6 K 表） | 5 条裁定 | 建议追加一行登记（非裁定，仅登记）：`K-07 \| --fee/--qty 等数值旗标的非法字面量（新增缺陷 D-10） \| 是缺陷，已修复 \| 非法字面量必须 exit≠0 且零写入；合法字面量（0 / 5.5 / 1e3 / 100）不得被误杀 \| E2E-N-100（violation）+ E2E-P-19（legal）` |

---

## B. `docs/qa/user-operation-matrix.md`

### B-1 §11 守卫清单「预期」列与产品实测不符（5 条）

| 行号 | 守卫 | 原描述（关键部分） | 应改成 |
|---|---|---|---|
| 450 | `G-21` | 预期列仍写 `ADD-TIME-FORGERY: exit 0 · Δ lots+1、trades+1`、`违规侧：**存在未达标项**（ADD-TIME-FORGERY、ADD-FORGED-INVISIBLE）` | `ADD-TIME-FORGERY`: exit `1` · Δ **0**（各表前后相等） · stdout/stderr「成交时间不得晚于当前时间：加仓成交时间 传入 … 晚于当前 …，已拒绝写入账本」；`ADD-FORGED-INVISIBLE` 同；`ADD-AFTER-48H`: exit `0`、Δ lots+1、trades+1（窗口外合法回填仍放行）；违规侧改为 **全部拦截/拒绝成功** |
| 451 | `G-22` | 预期列引用的 stderr 为旧文案：`买入数量必须为 100 的整数倍 (一手单位)，当前输入: 150` / `买入数量必须大于 0` | `BUY-NON-ROUND`: stderr「--qty 必须是 100 股整数倍（一手 = 100 股），收到: 150 股」；`BUY-ZERO-QTY` / `BUY-NEG-QTY`: stderr「--qty 必须为正整数股数（单位: 股），收到: 0 / -100」（exit 1 · Δ 0 不变） |
| 462 | `G-33` | 预期列 `SCAN-MENU-KEYS: exit 0 · Δ 0`；违规侧「**存在未达标项**（SCAN-MENU-KEYS）」 | `SCAN-MENU-KEYS`（照抄 `scan --help` **当前**示例 `{"take_profit_min":0.05,"dip_1":-0.08}`）: exit `0` · Δ `signals`+1（命中 `TAKE_PROFIT_ALERT`）；并补一条：旧版 help 的键集合 `{"add":-0.1,"take":0.1}`: exit `1` · Δ 0（D-07 键名校验）；违规侧改为 **全部按预期处理** |
| 473 | `G-44` | 预期列 `SCAN-BAD-THRESHOLD: exit 0 · Δ 0`；违规侧「**存在未达标项**（SCAN-BAD-THRESHOLD）」 | `SCAN-BAD-THRESHOLD`: exit `1` · Δ 0 · 文案含「数值字面量」/键名不在读取集；违规侧改为 **全部拦截/拒绝成功** |
| 474 | `G-45` | 预期列仍引用 NaN 时代输出（`BUY-PRICE-NAN`: exit 0 · Δ lots+1 … `成交单价: NaN 元`、`NAN-POLLUTION-POS`: `"total_cost": null`）；违规侧「**存在未达标项**（PRICE-GUARD-ILLEGAL、BUY-PRICE-NAN、BUY-PRICE-ZERO、BUY-PRICE-NEG）」 | `PRICE-GUARD-ILLEGAL` / `BUY-PRICE-NAN` / `BUY-PRICE-ZERO` / `BUY-PRICE-NEG`: 全部 exit `1` · Δ **0** · 文案含「非法成交价」；`PRICE-GUARD-LEGAL` / `BUY-OK-FLAGS`: exit `0` · Δ lots+1、trades+1；`NAN-POLLUTION-*` 观测行删除（污染路径已消失）；违规侧改为 **全部拦截/拒绝成功** |

### B-2 §11 建议新增守卫行（G-46）

建议在 §11 表尾（474 行之后）追加下列一行（完整可粘贴，`|` 按矩阵现有习惯用 `\|` 转义取值区间时请注意；本行内无取值区间）：

```
| **G-46** | 拦截 | `PRICE-GUARD-ILLEGAL` `FEE-GUARD-ILLEGAL` `QTY-GUARD-ILLEGAL` `STATS-DAYS-BAD` | 数值旗标（--price / --fee / --qty / --days 等）取非法字面量（非数值、千分位逗号、单位后缀、下划线、十六进制） | 字面量层统一拒绝：exit≠0、零写入、文案指明该旗标；合法字面量（0 / 5.5 / 1e3 / 7.0 / 100）一律放行 | `FEE-GUARD-ILLEGAL`: exit `1` · Δ **0**（各表前后相等） · 文案「--fee 必须是合法数值字面量（禁止千分位逗号 / 单位后缀 / 下划线 / 十六进制），收到: abc」 <br>`QTY-GUARD-ILLEGAL`: exit `1` · Δ **0** · 同构文案 <br>`STATS-DAYS-BAD`: exit `1` · Δ **0** · 同构文案 <br>`FEE-GUARD-LEGAL`（--fee 0 / --fee 5.5）: exit `0` · Δ `lots`+1 · `cost_basis_unit` 有限正数（5.5 时 = price + fee/qty） <br>`QTY-GUARD-LEGAL`（--qty 100）: exit `0` · Δ `lots`+1 | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝非法字面量（应拒绝）；合法侧＝等价合法写法（应放行且数值正确换算） | L5 证据 `E2E-N-100.json` / `E2E-P-19.json` |
```

（若贵方认为应并入 `G-45`，则按同一命题合并，勿两行并存。）

### B-3 §14.1 修复状态补全（6 条缺 + 1 条新增）

| 行号 | 现状 | 应改成 |
|---|---|---|
| 593–611 | `#### D-02（P2）…` 缺「修复状态」段 | 追加：**修复状态（commit c895025/c895274）：已修复。** `trade scan --help` 改为按实现读取的键逐条列出（`take_profit_min / trailing_activate / trailing_pullback / dip_1 / deep_value`）并给出示例 `{"take_profit_min":0.05,"dip_1":-0.08}`；D-07 的键名/类型校验生效后，照抄该示例 exit 0 且命中 `TAKE_PROFIT_ALERT`，旧键集合 exit 1 且零信号（L5 `E2E-N-65`） |
| 612–633 | `#### D-03（P2）…` 缺「修复状态」段 | 追加：**修复状态：已修复。** 未声明参数一律 exit≠0 且零写入并给出「未声明的参数 <flag>（命令: trade <cmd>）」；副作用需登记：`lot buy` 的建仓理由旗标是 `--reason`（`--buy-reason` 仅属 `lot edit`），D-03 生效后把 `--buy-reason` 传给 `lot buy` 会被拒——旧用例 `E2E-N-55/56` 正是靠静默忽略才「通过」，判据已按 help 修正（L5 §5 注释） |
| 634–649 | `#### D-04（P3）…` 缺「修复状态」段 | 追加：**修复状态：已修复。** 输出目录不存在时 exit 1、stderr 无解释器堆栈（`E2E-N-93`：`不得抛出未捕获堆栈 matched=false`，六表 Δ=0） |
| 650–667 | `#### D-05（P2）…` 缺「修复状态」段 | 追加：**修复状态：已修复。** `stats --days abc` exit 1、文案「--days 必须是合法数值字面量…」，报表保持原样（默认窗口 1 笔 → 非法调用后仍 1 笔，未被清空）；`--days 7.0` / `--days 1e3` 属合法等价写法，仍 exit 0 |
| 687–703 | `#### D-07（P2）…` 缺「修复状态」段 | 追加：**修复状态：已修复。** 阈值键名与取值类型统一校验：未知键 / 非数值取值一律 exit 1 且零写入（`E2E-N-88` 两组均 exit 1、Δ 0）；合法覆盖照常生效（`E2E-N-89`） |
| 704–714 | `#### D-08（P2）…` 缺「修复状态」段 | 追加：**修复状态：已修复。** 新增 `trade dashboard --api-base <url>`（help 明示「Pass the address `trade serve` is actually listening on」）；产物内 `LOCAL_API_BASE` = 传入值，配合 `trade serve --port 18xxx` 可在本话题端口边界内完成联动转绿（L5 `E2E-N-96/97`：顶栏 `class=local` + 「本地引擎已联动」，停机后平滑降级 `standalone`） |
| 745 之后 | 无 D-10 条目 | 新增 `#### D-10（P2）数值旗标字面量守卫缺失（核验中新增）` 小节：现象（`--fee abc` / `--qty abc` 不进字面量守卫）、复现命令、观测点（exit 1 · Δ 0 · 文案含「数值字面量」）、**修复状态：已修复**、对应用例 `E2E-N-100` + `E2E-P-19` |

### B-4 §14.2 非阻塞观测（1 条口径已变）

| 行号 | 原描述 | 应改成 |
|---|---|---|
| 750 (`V-01`) | `未知参数与未知子动作被静默忽略：裸位置参数被忽略；未知子动作回落父级 help 且退出码为成功，而根级未知参数为失败退出` | `未知参数与未知子动作的处置已部分收敛（D-03）：已知子命令上的**未声明参数**一律 exit≠0 且零写入；**未知子动作**回落父级 help 但退出码已改为非 0（实测 trade lot bogus → exit 1）；裸位置参数（trade lot list extra / trade account add … extra）仍被静默忽略、exit 0；根级未知参数 exit 1` |

### B-5 §14.3 BLOCKED 清单（2 条应解除）

| 行号 | 原描述 | 应改成 |
|---|---|---|
| 399 / 774 | `SERVE-8080-LINKED … **BLOCKED** · 缺失能力：允许绑定该端口的授权，或看板生成器的基址覆盖参数（当前不存在）` | 删除 BLOCKED 标记，改记：`已解除（D-08）：trade dashboard --api-base 落地后，用 18000–18999 内的实际端口生成看板即可完成联动验证（L5 E2E-N-96/97，exit 0，产物探活基址 = 引擎实际地址）` |
| 400 / 775 | `SERVE-DUAL-MODE-GREENLIGHT … 需要无头浏览器读取 DOM 指示灯状态，本线未获浏览器驱动授权；且叠加了固定端口的阻塞` | 改记：`已解除：本机 headless Chrome 可用（E2E-P-17 已在用），叠加阻塞项 D-08 已修；L5 实测 serve(18186) + --api-base → 顶栏 class=local 且文案「本地引擎已联动」，停机后同页降级 standalone，两态 DOM >1000 字符且无 NaN` |
| 776（§14.3 小结句） | `10 条 BLOCKED 行同样在各自的操作行备注栏里写明了缺失能力，两处一致。` | 改为 `8 条 BLOCKED 行…`（两条解除后重算条数） |

### B-6 §15 隔离自查（建议追加一段 L5 可复跑块）

在 §15 末尾追加（可直接复跑、不含生产账本）：

```bash
# L5（commit c895274 / trade 0447ac7d…d64b4）复跑
TS=$(date +%Y%m%d-%H%M%S)
bun docs/qa/tools/run-e2e.ts --out /tmp/qa-tp-458199de-L5-$TS --no-writeback
# 期望 total=119 pass=116 fail=0 blocked=2 legal_fail=0 pair_na=1
bun docs/qa/tools/check-e2e-flow.ts --results docs/qa/evidence/tp-458199de-L5-20261026-024927-commit-c895274/results.json
shasum -a 256 ~/.trade/trade.db   # 期望 1ec361a6…aef59 不变
```

---

## C. 判定与建议

- 本清单覆盖 **flow md 9 处行级 + 5 处章节级**、**matrix 5 处守卫行 + 1 处新增守卫 + 7 处 §14.1 + 1 处 §14.2 + 3 处 §14.3**。
- 建议处理顺序：① 评审并接受 `harness-repairs.diff`（8 项判据修复）→ ② 回写一次 flow md（机械列）→ ③ 按 §A-3/§B 逐条改人工正文 → ④ 复跑并刷新 §8 汇总行。
- **实施结果（round-2）**：① 已接受并合入；② 已由 `run-e2e.ts --write` 回写；③ 已按 §A-3/§B 逐条改完；④ 已刷新 §8.1 汇总行并在实际文档上跑 checker 得**全零**（上面四处均为 0）。因此「在 ①②③ 完成前 checker 会报 `result_mismatch=12`」只是 round-1 的历史状态，已不再成立（round-1 的 `result_mismatch=12` 及提议版流程均已在 §A-1 / §C 上方存档）。

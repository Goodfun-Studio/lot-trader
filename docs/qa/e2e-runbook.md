# lot-trader E2E 质检运行规范 (E2E QA Runbook)

版本：v1.0.0
话题：tp-5a3bfad8 · line-qa-runbook-report (L4)
负责角色：persona-lot-trader-qa
上游产物：`docs/qa/user-operation-matrix.md`(L1)、`docs/qa/e2e-test-flow.md`(L2)、`docs/qa/guard-unit-test-map.md`(L3)
下游门禁：`docs/qa/release-gate.md` Gate 1~5

本文件是「把 L1~L3 的产物串成一次可执行质检」的操作手册。所有步骤都是可复制粘贴的命令，
所有判定都必须落到「执行命令 → 前后观测数值 → 可证伪判据」三段式，严禁代码观感与主观推测。

---

## 触发条件

什么情况下必须跑本规范，以及每种情况分别跑哪几道门。以「改动面最小充分」为原则：改到哪里，跑到哪里。

| # | 触发场景 | 判据（可机械判定） | 必跑内容 |
|---|---|---|---|
| T1 | `./trade` 重新构建 | `shasum -a 256 ./trade` 与上一份证据 `results.json` 的 `meta.tradeSha256` 不同 | 全量：Gate 1 → Gate 2 → Gate 3 → Gate 4 → Gate 5 → 报告 |
| T2 | `src/` 有改动 | `git status --porcelain -- src` 非空，或 `git diff --name-only <last-release-commit>..HEAD -- src` 非空 | 全量：Gate 1 → Gate 2 → Gate 3 → Gate 4 → Gate 5 → 报告（`src/` 是单二进制唯一输入，任何一行改动都可能同时动到核算、风控与看板） |
| T3 | `tests/` 有改动 | `git diff --name-only <last-release-commit>..HEAD -- tests` 非空 | Gate 1 + Gate 5（单测基线与负向守卫断言可能被改弱） |
| T4 | 发布前（出包） | 老板下达发版指令，或 `trade` 版本号变化 | 全量：Gate 1 → Gate 2 → Gate 3 → Gate 4 → Gate 5 → 报告；报告须归档到 `docs/qa/reports/` |
| T5 | 只改 `docs/qa/**`（文档/工具/证据） | `git status --porcelain` 的改动路径全部以 `docs/qa/` 开头 | 只跑对应的 checker（见下表），既不做 Gate 2、也不跑 Gate 3/4；若改了 `docs/qa/tools/run-e2e.ts`，须补一次 Gate 3/4/5 实跑以证工具本身可跑 |
| T6 | 定时巡检 / 老板要求「体检」 | 无代码改动，仅想看现状 | Gate 3 + Gate 4 + Gate 5 + 报告（Gate 1/2 可引用最近一次同 commit 的结果，须在报告中注明引用来源） |

按改动类型选择的具体门：

| 改动类型 | 受影响的门 | 理由 |
|---|---|---|
| 核算/引擎（`src/engine.ts`、`src/calc.ts`、`src/db.ts`） | Gate 1、Gate 3、Gate 5 | 分文不差与 30% 硬顶、48h 防抖都在这里 |
| 行情/物理（`src/quotes.ts`、`src/physics.ts`） | Gate 1、Gate 3 | 断言依赖行情 provider 与雷达字段 |
| 服务端（`src/serve.ts`） | Gate 1、Gate 4、Gate 5 | 回环绑定、401、零泄漏、看板联动 |
| 看板生成（`src/dashboard*`、`scripts/template_base.html`） | Gate 1、Gate 4 | 单文件自驱与联动双模 |
| 仅 CLI 文案/帮助 | Gate 3（L1 checker 会重算命令契约） | 帮助文本是 L1 矩阵的对账基准 |

---

## 沙箱规范

**一句话：每一次 `trade` 调用都必须同时满足下列四项，缺一不可。** 任何一项不满足，执行器必须**执行前拒绝**并把拒绝原因追加到 `<证据目录>/harness-guard-violations.txt`，不得进入 `commands.log`。

1. **`--db` 一律指向 /tmp 沙箱**，且必须是本次运行沙箱目录下的路径。
   - 形如 `--db /tmp/qa-tp5a3bfad8-<line>-<时间戳>/db/<用例 ID>.db`。
   - 严禁：不写 `--db`（会落到默认路径 `~/.trade/trade.db`，见下面「与 release-gate.md 的口径冲突」第 3 条）、`--db /tmp/..` 之外、`--db` 指向仓库内。
   - 负向场景每个用例一个**独立库**；正向连续链路共用一个 `lifecycle.db`。
2. **`HOME` 设为沙箱里的 fakehome**：`HOME=/tmp/qa-tp5a3bfad8-<line>-<时间戳>/fakehome`。
   - 真实 `HOME` 会被 `src/db.ts:10` 的 `DEFAULT_DB_PATH = join(homedir(), ".trade", "trade.db")` 兜底命中，所以 HOME 重定向是最后一道闸。
   - 连带防护：`~/.lot-trader/session.token` 也必须被挡在沙箱里。
3. **`LOT_TRADER_TOKEN_FILE` 指向沙箱**：`LOT_TRADER_TOKEN_FILE=<沙箱>/fakehome/.lot-trader/session.token`。
   - 同时把 `LOT_TRADER_DB` / `TRADE_DB_PATH` 也全部指向沙箱，作为 `--db` 之外的三重冗余。
4. **serve 端口只用 18000–18999**，随机选取、占用则换端口。
   - 不用 8080（那是看板写死的探活地址所在端口，日常被其它进程占用，且与「每个用例独立沙箱」冲突）；
   - 不用 `--port 0`（内核随机端口可能落到 1024 以下的特权区，也可能正好落在运行中服务的端口上，取证时无法预判与复核）；
   - serve 只绑 `127.0.0.1`，每次停机后必须证明端口已释放（`lsof -nP -iTCP:<port> -sTCP:LISTEN` 为空）。

### 收尾清理三件事

每次运行结束必须按顺序做完这三件，缺一件视为本次运行不可采信：

1. **停掉 serve**：`ps -eo pid,ppid,etime,command | grep -E 'trade serve' | grep -v grep` 必须为空；
   对每个残留 PID 先 `kill -TERM`，再复核 `lsof -nP -iTCP:18000-18999 -sTCP:LISTEN` 中本线端口已无监听。
   （`SIGTERM` 才会走清理逻辑；`SIGKILL` 会残留 `~/.lot-trader/session.token` 旧凭证。）
2. **删除沙箱**：`rm -rf /tmp/qa-tp5a3bfad8-<line>-<时间戳>`，然后复核目录不存在；
   仓库内证据目录**不删**（证据是交付物）。
3. **核对生产指纹**：把本次 `isolation-end.txt` 与 `isolation-start.txt`、以及与开工基准
   `reports/tp-5a3bfad8-isolation-baseline-<时间戳>.txt` 逐项比对：
   - 生产账本 `~/.trade/trade.db` sha256：只算 sha256、只读，**绝不允许打开**；
   - `~/.lot-trader/` 清单（去掉 `..` 那一行）必须逐行一致；
   - 看板 `lot-trader-global-dashboard.html` sha256 一致；
   - `./trade` sha256 与本次运行的 `results.json` 的 `meta.tradeSha256` 一致。
   任一项不一致 → 立刻停止、以「问题」上报，不得继续下一步。

> 关于 `~/.trade/trade.db-shm`：它不是内容是否被改写的判据。SQLite 只要建立一次 WAL 连接就会前移它的 mtime（见「与 release-gate.md 的口径冲突」第 3 条）。生产指纹一律以 `trade.db` + `trade.db-wal` 的 sha256 为准。

---

## 执行顺序与 Gate 对应

顺序是硬性的：**先静态 → 再单元 → 再实跑 → 最后出报告**。前一步没有产物就不要开下一步。

### 第 0 步（前置）— 建立线级目录与 isolation-start

```bash
cd /Users/ivywu/Downloads/GitHub/Goodfun-Studio/lot-trader
TS=$(date +%Y%m%d-%H%M%S)
LINE_DIR="docs/qa/evidence/tp-5a3bfad8-L4-line-${TS}"
mkdir -p "$LINE_DIR"
# 写入 isolation-start.txt（生产账本 sha256 / ~/.lot-trader 清单去掉 .. 行 / 看板 sha256 / ./trade sha256 / git status --porcelain）
```

- **对应 Gate**：无（前置）。它是后面所有 Gate 的**隔离前提**：没有基准就没有「生产未被污染」的证明。
- 本线所有命令逐行追加到 `<LINE_DIR>/commands.log`，每行带 ISO 时间戳，只追加不改写。

### 第 1 步 — L1 操作矩阵 checker（命令契约基线）

```bash
bun docs/qa/tools/check-op-matrix.ts            # 输出一行计数
bun docs/qa/tools/check-op-matrix.ts --strict   # 任一计数非 0 退出码 1
bun docs/qa/tools/check-op-matrix.ts --inject-canary   # 自检：注入伪命令，必须 missing=1
```

- 输出：`commands=<N> flags=<N> missing=<N> extra=<N> evidence_missing=<N> ghost_db=<N>`
- **对应 Gate**：**Gate 3 / Gate 4 / Gate 5 的前置**。它把 `./trade --help` 树与 L1 矩阵逐条对账，是「待测命令集合本身没有缺项/多项」的证明。矩阵是错的，后面所有用例的长短都会跟着错。
- 特别看 `ghost_db`：它统计「矩阵里写了、但文件其实不存在的 `/tmp` 目标有没有被真的建出来」。`ghost_db=0` 是「矩阵里的命令没有被真的执行过」的旁证。

### 第 2 步 — L3 守卫单测映射（Gate 1 的隔离版）

```bash
bun docs/qa/tools/check-guard-unit-map.ts                        # 真实映射，期望全 0
bun docs/qa/tools/check-guard-unit-map.ts --inject-missing-test      # 期望 test_missing=1
bun docs/qa/tools/check-guard-unit-map.ts --inject-excerpt-mismatch  # 期望 excerpt_mismatch=1
```

- 输出（在原 8 字段之后追加 `parse_mismatch`）：
  `... test_missing=<N> excerpt_mismatch=<N> parse_mismatch=<0|1>`
- **对应 Gate**：**Gate 1（静态与单元基线）**。它替 Gate 1 回答两件事：(a) 每条守卫都有对应的单测落点或明确的 GAP 记录；(b) 单测结果可解析、`pass/fail/skip` 与末尾汇总行对得上（`parse_mismatch=0`）。
- **它只在 /tmp 副本里跑 `bun test`**，绝不在仓库内跑 —— 原因见「与 release-gate.md 的口径冲突」第 3 条。

### 第 3 步 — L2 E2E 实跑（Gate 3 + Gate 4 + Gate 5）

```bash
bun docs/qa/tools/run-e2e.ts --no-writeback --out docs/qa/evidence/tp-5a3bfad8-L4-run-<时间戳>-commit-2081243
```

> 开关名以 L2 定稿为准（当前工作树已有 `--out <dir>` 与 `--no-writeback`）；若 L2 改名，本节命令随之更新，命令含义不变。

- `--out` 指向**新目录**，且**不得与线级目录 `tp-5a3bfad8-L4-line-<时间戳>` 混用**：runner 会往里写 `isolation-start.txt` / `isolation-end.txt`，与线级快照混用会互相覆盖。
- `--no-writeback` 禁止回写 `docs/qa/e2e-test-flow.md`（L2 的产物归 L2；本线只产证据与报告）。
- 产出：`results.json`、每条用例的 `.cmd/.stdout/.stderr/.exit/rows-before.txt/rows-after.txt`、`<用例 ID>.json`、`<用例 ID>.rows.md`、`commands.log`、`harness-guard-violations.txt`、`isolation-start.txt`、`isolation-end.txt`。
- 内部阶段与 Gate 的对应。**用例数一律现算、不写死；范围用语义判据而不是 ID 区间** —— 用例集会随口径裁定持续增减（`E2E-N-99` 就是后加的，它落在 stage 2，不落在任何旧文档写过的区间里）：

```bash
# 四个 stage 的用例数（权威来源 = runner 自己的 --list；只列不跑，不调用 ./trade）
bun docs/qa/tools/run-e2e.ts --list | grep -o 'stage=[0-9]' | sort | uniq -c

# 每个 stage 的精确用例 ID 清单（要看范围就现拉，别抄文档里的区间）
bun docs/qa/tools/run-e2e.ts --list | awk -F'\t' '$2 ~ /^stage=/ {print $2"\t"$1}' | sort

# 合计自检：末行应打印 total=<用例数>/<用例数>
bun docs/qa/tools/run-e2e.ts --list | tail -1
```

| runner 阶段 | 用例范围（**语义判据**；精确 ID 用上面第二条命令现拉） | 用例数 | 对应 Gate |
|---|---|---|---|
| stage 0 · 环境前置与隔离 | runner 里 `stage: 0` 的用例 —— 沙箱自建、`--help` 零写库、全局选项与环境变量优先级、采集器隔离守卫实弹自检及其合法侧对照 | 8 | 全部 Gate 的前置（没有它就没有「生产未被污染」的证明） |
| stage 1 · 正向全生命周期 | `stage: 1` 的用例 —— 账户注册 → 首次建仓 → 加仓与 48h 防抖 → 浮盈越线激活移动止盈 → 部分/全部平仓 → 理由追加 → 代冲平仓 → 分红登记 → `position`/`stats` 数值核对 → 看板单文件生成 → headless 浏览器走查 → `serve` 读回与 CLI 口径交叉核对 | 16 | **Gate 3**（沙箱黑盒全流程走查）+ **Gate 4**（看板双模冒烟） |
| stage 2 · 负向守卫成对 | `stage: 2` 的用例 —— 每条守卫的 violation（触发侧）/ legal（不触发侧）成对断言，含阈值覆盖与边界回归 | 86 | **Gate 5**（负向防误杀守卫全量） |
| stage 3 · 缺陷回归与阻塞 | `stage: 3` 的用例 —— 缺陷 D-01~D-09 回归 + 口径冲突/缺能力导致的 BLOCKED 项 | 7 | **Gate 5** + 缺陷 D-01~D-09 回归 |

> 上表「用例数」一列由本节第一条命令（`run-e2e.ts --list | grep -o 'stage=[0-9]' | sort | uniq -c`）生成。
> 快照＝ 2026-10-24 的 `run-e2e.ts`：8 + 16 + 86 + 7 = **117**（与 `--list` 末行的 `total=117/117` 自洽）。
> 数字对不上就自己去跑那三条命令：**不要把这里的数字抄进任何断言或判据**。

- 实跑后立刻交叉核对用例表：

```bash
bun docs/qa/tools/check-e2e-flow.ts --results <第 3 步的证据目录>
```

  输出：`cases=<N> pass=<N> fail=<N> blocked=<N> legal_fail=<N> pair_na=<N> uncovered=<N> unpaired=<N> evidence_missing=<N> blocked_no_reason=<N> result_mismatch=<N>`
  其中 `cases` 必须等于 `docs/qa/e2e-test-flow.md` 里的用例行数、也等于本次 `results.json` 的用例数（**不写死数字**：用例集会随口径裁定增减，一律现算），`result_mismatch` / `evidence_missing` / `uncovered` / `unpaired` 必须为 0。

  ```bash
  # 用例总数的唯一权威来源（别抄任何文档里的数字）
  grep -cE '^\|\s*E2E-' docs/qa/e2e-test-flow.md
  ```

### 第 4 步 — 生成正式报告

```bash
bun docs/qa/tools/gen-e2e-report.ts --evidence <第 3 步的证据目录>
bun docs/qa/tools/check-e2e-report.ts docs/qa/reports/e2e-report-<YYYYMMDD-HHMMSS>-commit-<sha>.md
```

- **对应 Gate**：**无（出具可执行证据报告）**。它是 release-gate.md 工作流最后一行
  `[出具可执行证据报告 -> 判定 PASS 放行 / FAIL 打回]` 的落地物。
- 报告文件名：`docs/qa/reports/e2e-report-<YYYYMMDD-HHMMSS>-commit-<sha>.md`，时间戳取 `results.json` 的 `meta.startedAt`，`<sha>` 取 `meta.commitShort`（8 位）。
  若本次证据目录用的是 7 位写法（`…-commit-2081243`），报告文件名请**沿用同一个 token**，用 `--sha` 指定：

  ```bash
  bun docs/qa/tools/gen-e2e-report.ts --evidence <证据目录> --sha 2081243
  ```

  目的是让「证据目录名」与「报告名」的 commit token 对得上，避免同一批产物出现两种 sha 写法。

### 一页速查

| 序 | 动作 | 命令 | Gate |
|---|---|---|---|
| 0 | 线级目录 + isolation-start | `mkdir -p docs/qa/evidence/tp-5a3bfad8-L4-line-<ts>` | 前置（隔离） |
| 1 | L1 操作矩阵 checker | `bun docs/qa/tools/check-op-matrix.ts --strict` | Gate 3/4/5 前置 |
| 2 | L3 守卫单测映射 | `bun docs/qa/tools/check-guard-unit-map.ts` | **Gate 1** |
| 2' | 单二进制编译（**Gate 2**，发布前才需要） | **由发布线执行，本规范不复述命令** | **Gate 2** |
| 3 | L2 E2E 实跑 | `bun docs/qa/tools/run-e2e.ts --no-writeback --out <新目录>` | **Gate 3 + Gate 4 + Gate 5** |
| 3' | L2 用例表对账 | `bun docs/qa/tools/check-e2e-flow.ts --results <run 目录>` | Gate 3/4/5 对账 |
| 4 | 生成 + 校验报告 | `gen-e2e-report.ts` → `check-e2e-report.ts` | 出具证据报告 |
| 5 | 收尾 | 停 serve / 删沙箱 / 核对生产指纹 → `isolation-end.txt` | 隔离闭环 |

> **Gate 2（单二进制编译）由发布线执行，本规范不复述其命令** —— 本规范无条件不 build。
> 这里只规定两件事：① T1/T2/T4 场景必须**先确认 Gate 2 已由发布线跑过**，再开始第 3 步实跑；
> ② 把 `./trade` 的 sha256 与本次 `results.json` 的 `meta.tradeSha256` 对齐 —— 否则实跑验的不是将来发布的那一个二进制。

---

## 阻断判定

规则一句话：**「产品该拦没拦 / 该放没放」和「隔离被破坏」阻断；「口径没定 / 缺能力」只记录。**

### 阻断发布（FAIL，未修复不得合并、不得发版）

| # | 阻断项 | 判定式（机械可算） | 为什么阻断 |
|---|---|---|---|
| B1 | **legal 侧 FAIL（产品误杀）** | `check-e2e-flow.ts` 的 `legal_fail > 0`，或 `results.json.summary.legal_fail > 0` | legal 侧是「必须放行、不告警、不发生状态转换」的输入。误杀会让老板在合法价位买不进、在合法窗口加不了仓 —— 直接伤钱。任何一条都是 P1 |
| B2 | **隔离计数不为 0** | ① `<run>/commands.log` 中不满足「同时含 `--db /tmp/` 且环境前缀 `HOME=<沙箱>/fakehome`」的行数 > 0；② `<run>/harness-guard-violations.txt` 中 `op=E2E-N-01`（唯一被允许的自检用例）以外的行数 > 0 | 隔离是整套口径的地基。有一条越界命令，这次运行里所有「账本没被污染」的结论都作废 |
| B3 | **violation 侧 FAIL 且严重级 P1** | `results.json.cases[*].result == "FAIL"` 且该用例关联缺陷的严重级为 P1（判定标准见下） | P1 = 资金安全 / 账本精度 / 凭证泄漏 / 无界崩溃。任一条命中即为发布阻断 |
| B4 | **生产指纹漂移** | `isolation-end.txt` 与 `isolation-start.txt`/开工基准的 生产账本 sha256 或 `~/.lot-trader/` 清单 或 看板 sha256 任一项不一致 | 说明本线或其它并行线真的动了生产物件，结论不可采信 |
| B5 | **Gate 1 未过** | `check-guard-unit-map.ts` 的 `parse_mismatch != 0`，或隔离环境 `bun test` 出现**非 flaky 清单内**的失败/挂起 | 基线破了，后面所有断言的前提（代码本身自洽）不成立 |
| B6 | **Gate 2 未过** | `./trade` 不存在 / 无执行权限 / `./trade --help` 退出码 ≠ 0 / `sha256(./trade) != results.json.meta.tradeSha256` | 实跑的对象不是将来发布的那个二进制，等于没验 |
| B7 | **Gate 4 未过（白屏 / NaN）** | Gate 4 的落点（runner 里 stage 1 的看板/联动用例）**任一条 FAIL**，或看板产物出现 `NaN` / 未捕获异常。集合用下方 **`B7-cmd`** 现拉，本表不写命令也不写 ID 区间 | 看板是老板唯一的日常入口，白屏等于全盲（**不按 ID 区间写死**：新看板用例会加，阶段一限制 + 标题关键词才能自动吃进来；`B7-cmd` 自带非空断言，选不到 3 条就直接报错退出） |
| B8 | **报告自身不干净** | `check-e2e-report.ts` 输出 `cases != 用例总数` 或 `missing_fields != 0` 或 `evidence_missing != 0` 或 `result_mismatch != 0`；或 `check-e2e-flow.ts` 的 `evidence_missing != 0` / `result_mismatch != 0` | 「证据不全」与「结论对不上证据」本身就是报告缺陷，不允许带病放行 |

#### `B7-cmd` — Gate 4 落点集合（现拉）

**逐字从下面这个代码块复制执行**。
不要从任何 markdown 表格里复制带 `|` 的命令 —— 表格里的 `|` 必须写成 `\|` 才能不把单元格切开，
而 `\|` 被 shell 当成字面参数，会让整条管道**静默失效**（选不中任何东西但仍 exit 0）。

```bash
n=$(bun docs/qa/tools/run-e2e.ts --list | awk -F'\t' '$2=="stage=1"' | grep -E '看板|headless|serve|联动' | wc -l | tr -d ' ')
test "$n" -eq 3 || { echo "B7 判据命中 $n 条，预期 3 条：请先核 看板/headless/serve/联动 的关键词是否仍覆盖 Gate 4"; exit 1; }
bun docs/qa/tools/run-e2e.ts --list | awk -F'\t' '$2=="stage=1"' | grep -E '看板|headless|serve|联动' | awk -F'\t' '{print $1}'
```

实测输出（`run-e2e.ts` 的 117 条版本）：

```
E2E-P-16
E2E-P-17
E2E-P-18
```

预期恰为 **3 条**（`E2E-P-16` 单文件生成 / `E2E-P-17` headless 走查 / `E2E-P-18` serve 联动）。
条数变了不是文档过期就是看板用例集变了：先跑 `n=$(…) ; echo "$n"` 看命中几条，再决定是改关键词还是改文档，
**不允许把这条断言去掉后带着一个错集合去判 B7**。

**P1 / P2 / P3 的判定标准（用于 B3，也给只记录项定级）：**

| 级别 | 覆盖面 | 典型 |
|---|---|---|
| **P1** | 资金安全、账本精度、凭证/账本泄漏、无法恢复的崩溃 | 30% 硬顶被绕过；48h 冷却被绕过（含未来成交时间法）；401 被绕过或响应体泄漏账本字段；serve 绑非回环；`session.token` 权限非 `0600`；核算金额与手工复算不一致（哪怕 0.01）；核心链路抛未捕获异常并产生零写库 |
| **P2** | 功能可用性受损但有绕行、口径明确被违反、错误码/文案与契约不符 | 错误码与 `--help`/矩阵声明不符；非法入参静默生效；降级态误报；`--json` 结构缺字段 |
| **P3** | 体验、展示、非阻断的隔离纪律偏差 | 文案小数位、分位数展示、2 个测试套件直连生产账本路径导致 `-shm` mtime 前移 |

### 只记录、不阻断

| # | 只记录项 | 判定式 | 记录形式 |
|---|---|---|---|
| R1 | **口径未定（BLOCKED）** | `results.json.cases[*].result == "BLOCKED"`，且 `<用例 ID>.json` 的 `blockedReason` 写了「口径待老板确认」 | 报告里单列「待确认口径」一表，写清候选口径 (a)/(b)/(c)、各自规则来源、实测行为。**不得自选口径判 FAIL 或 PASS** |
| R2 | **能力缺失型 BLOCKED** | `blockedReason` 写「缺失能力：…」 | 报告里单列，并给出补齐能力的最小改动建议 |
| R3 | **flaky 清单内的失败** | 失败用例名 ∈ `guard-unit-test-map.md §2.1` 的两条（见冲突第 2 条） | 记录命中次数与耗时，不阻断；但必须在报告中显式声明「本条不构成 Gate 1 通过」 |
| R4 | **P2 / P3 缺陷** | B3 之外的所有 `violation` 侧 FAIL | 进缺陷表，给编号与复现命令，按 P2/P3 排期 |
| R5 | **非阻断的隔离纪律偏差** | 例如 L3 记录的「2 个测试套件直连生产账本路径」 | 记录 + 提跟踪项；若已确认对账本字节级零改动（主库 sha256 与六表行数不变、`-wal` 恒 0 字节）则不阻断 |
| R6 | **`pair_na`** | `kind == "pair_na"` 且写明原因 | 计入对账计数，不阻断；原因缺失则升级为 B8 |

---

## 打回格式

打回给开发（`persona-strategy-automator`）的单据必须**每条缺陷一张**，字段一个都不能少。缺字段的单据视为无效，退回质检线补齐。

### 单据模板（纯文本，可直接贴进消息）

```
缺陷编号：<L4-D-YYYYMMDD-NN>
严重级：<P1|P2|P3>
用例 ID：<E2E-X-NN>
关联守卫：<G-NN 或 —>
关联缺陷：<D-NN（来自 e2e-test-flow.md 阶段 3）或 新增>

命令：
  <逐字复制 <证据目录>/<用例 ID>__<n>.cmd 里 `$ ` 开头的那一行；多步用例按顺序全列>

前状态：
  <逐字复制 <证据目录>/<用例 ID>__<n>.rows-before.txt 的内容；或字段名=旧值 的清单>

后状态：
  <逐字复制 <证据目录>/<用例 ID>__<n>.rows-after.txt 的内容；或字段名=新值 的清单>
  <附 exit=<N>／HTTP <状态码>／stdout 关键片段>

期望：
  <逐字复制 docs/qa/e2e-test-flow.md 用例表「预期」列；并写明预期值来源（规则文件名+章节）>

实际：
  <观测到的实际输出：错误码 / 响应体 / 字段值 / 崩溃堆栈首行；不得改写、不得省略>

证据路径：
  <证据目录>/<用例 ID>.json
  <证据目录>/<用例 ID>.rows.md
  <证据目录>/<用例 ID>__<n>.stdout
  <证据目录>/<用例 ID>__<n>.stderr
  <证据目录>/<用例 ID>__<n>.exit
  <报告路径>#<用例 ID 锚点>
```

### 填写纪律

1. **命令**必须是**真的跑过**的那一行（从 `.cmd` 证据文件复制），不是用例表里的设计稿。
2. **前状态 / 后状态**必须是数值，不是形容词。写「lots 从 `2` 变为 `3`（Δ=+1）」，不写「数据变了」。
3. **期望**只能引用既有规则文件（`safety-checklist.md` / `acceptance-cases.md` / `regression-baseline.md` / `MANUAL.md` / `SKILL.md` / `./trade --help`），严禁自己发明预期值；规则来源没写清楚的，转 R1 记 BLOCKED，不要打回。
4. **实际**必须是原始观测（含 `exit=`、错误码、`stderr` 首行）。允许粘贴堆栈首行与关键行，不允许「大致是…」「看起来是…」。
5. **证据路径**必须全部真实存在（可用 `ls` 逐个复核）。跨设备递交时改写成 `attachment.signUrl` 的链接。
6. 一张单据只写一条缺陷。同一守卫的多条表现拆成多张，或在一张里用「同源观察」小节附列，但**缺陷编号只给一个**。

### 与释放流程的衔接

- 打回后开发修完，**不重新走一遍全量**，而是：
  1. 复跑该用例：`QA_E2E_ONLY='^E2E-N-41$' bun docs/qa/tools/run-e2e.ts --no-writeback --out <新目录>`（调试用，不进正式证据）；
  2. 修复确认后按本规范 T1/T2 全量重跑，重开一份证据目录与报告，**旧证据目录一律不删、不覆盖**；
  3. 新报告的「缺陷回归」小节里逐条标注旧缺陷编号 → 新结果。

---

## 证据报告模板

报告由 `docs/qa/tools/gen-e2e-report.ts` 自动生成，五个字段**全部从证据目录里抽取，不得手写**。
文件名：`docs/qa/reports/e2e-report-<YYYYMMDD-HHMMSS>-commit-<sha>.md`。

> 本节下面引用的骨架是**示意**，写在围栏里。本文件的真实二级标题恰好是上面那七个（`grep -cE '^## (触发条件|沙箱规范|执行顺序与 Gate 对应|阻断判定|打回格式|证据报告模板|与 release-gate\.md 的口径冲突)$' docs/qa/e2e-runbook.md` → `7`）；骨架里出现的 `##` 行属于代码块内容，不是本文的章节。

### 报告骨架

```markdown
# lot-trader E2E 质检报告 · <证据目录名>

> 本文件由 docs/qa/tools/gen-e2e-report.ts 从证据目录自动生成；五个字段全部取自证据文件，不得手改。

## 1. 运行概要
<表：话题 / 证据目录 / commit / ./trade sha256 / 沙箱路径 / 开始时间 / 结束时间 / 耗时 ms>

## 2. 结果汇总
| 用例总数 | PASS | FAIL | BLOCKED | legal FAIL | pair_na |
|---|---|---|---|---|---|
| <用例总数> | … | … | … | 0 | … |

### 2.1 legal 侧 FAIL（防误杀）
无                     ← 有则逐条列出：用例 ID · 期望 · 实际 · 证据

### 2.2 逐用例结果与证据索引
| 用例 ID | kind | guards | 结果 | 证据 |
|---|---|---|---|---|

## 3. 用例证据明细
（每条用例一个 `###` 小节，含下面五个字段）

## 4. 阻断项 / 缺陷表 / 待确认口径
```

### 每条用例的五个字段（顺序固定）

```markdown
### <用例 ID> · result=<PASS|FAIL|BLOCKED> · kind=<positive|violation|legal|pair_na> · guards=<G-NN,…|—>

- **命令**：<从 <用例 ID>.json 的 steps[].cmd 抽取；多步以 ` → ` 连接，逐字不改；steps 为空时写「（未执行 · <blockedReason>）」>
- **输入/环境**：<从 <用例 ID>__<n>.cmd 的 `# env:` 头抽取 HOME/LOT_TRADER_DB/TRADE_DB_PATH/LOT_TRADER_TOKEN_FILE；db 取自 <用例 ID>.json 的 db 字段；serve 类用例补 host:port>
- **前状态**：<从首个执行步的 rows-before.txt 抽取六表行数（accounts/symbols/lots/trades/signals/dividends）；无快照时写「（无 rows-before 快照 · steps=<n>）」>
- **后状态**：<从末个执行步的 rows-after.txt 抽取六表行数 + 全部步骤的 exit 码；并把前→后写成 `旧→新 (Δ)`>
- **判据**：<从 <用例 ID>.json 的 expect + asserts 抽取：预期原文 · 断言 n_ok/n_total · 失败断言标签；结果取自 result 字段>
```

### 字段来源对照（生成器实现口径）

| 字段 | 唯一来源 | 禁止来源 |
|---|---|---|
| 命令 | `<用例 ID>.json` → `steps[].cmd`（其 `.cmd` 证据文件为交叉验证） | 用例表设计稿、人工转述 |
| 输入/环境 | `<用例 ID>__<n>.cmd` 的 `# env:` 头 + `<用例 ID>.json` → `db` | 记忆、约定 |
| 前状态 | 首个执行步 `<用例 ID>__<n>.rows-before.txt` | 推算、估计 |
| 后状态 | 末个执行步 `<用例 ID>__<n>.rows-after.txt` + `steps[].exit` | 推算、估计 |
| 判据 | `<用例 ID>.json` → `expect` / `asserts` / `result` | 重新解释规则、自己写预期 |

### 报告自检（必跑）

```bash
bun docs/qa/tools/check-e2e-report.ts <报告路径>
# 期望：cases=<e2e-test-flow.md 用例总数> missing_fields=0 evidence_missing=0 result_mismatch=0
bun docs/qa/tools/check-e2e-report.ts <报告路径> --inject-missing-field
# 期望：missing_fields=1（真的删掉某条用例的一个字段后走同一条检测路径）
bun docs/qa/tools/check-e2e-report.ts <报告路径> --inject-result-mismatch
# 期望：result_mismatch=1（真的改掉一条用例的结果使其与 results.json 不符）
```

四项计数的口径：

| 计数 | 含义 | 目标 |
|---|---|---|
| `cases` | 报告里解析出的用例块数 | 等于 `docs/qa/e2e-test-flow.md` 的用例行数，也等于 `results.json` 的用例数 |
| `missing_fields` | 五字段（命令 / 输入·环境 / 前状态 / 后状态 / 判据）中缺失或值为空的实例数 | 0 |
| `evidence_missing` | 报告 §5 执行步证据索引与 `results.json` 的 `cases[].evidence` 对不上、或引用的证据文件不存在的用例数 | 0 |
| `result_mismatch` | 报告里用例结果与 `results.json` 不一致（含只存在于一侧）的用例数 | 0 |

两个 `--inject-*` 开关是**真改报告文本**（删行 / 改字），把改后的文本落盘到 `/tmp` 副本、走同一条检测路径、然后立即回收 —— **不是**把计数直接写成 `+1`。两个可以同时给。
另有一项不占计数但会让 `--strict` 失败的配对检查：报告 §1 的「证据目录」必须等于 `results.json` 的 `meta.evidenceDir`，否则说明报告与 `--results` 不是同一次运行（跨次混搭）。

#### 变异自检（在 /tmp 副本上做，不碰正式报告）

除两个 `--inject-*` 开关外，还要手工做四项变异以证明检测路径是真的。这四项都在 `/tmp` 副本上改字：

```bash
cp <正式报告> /tmp/mut/base.md
# A. 删掉某条用例的「前状态」 → 期望 missing_fields=1
# B. 把某条 PASS 用例的 result=PASS 改成 result=FAIL → 期望 result_mismatch=1
# C. 整块删掉某条用例 → 期望 cases 减 1 且 result_mismatch=1
# D. 删掉 §5 证据索引行里的一个文件名 → 期望 evidence_missing=1
for f in /tmp/mut/*.md; do bun docs/qa/tools/check-e2e-report.ts "$f"; done
```

四项必须都只命中对应的那一个计数（A 只能动 `missing_fields`，B/C 只能动 `result_mismatch`，D 只能动 `evidence_missing`），多动任一项即为 checker 误报。

---

## 与 release-gate.md 的口径冲突

逐条列出：`release-gate.md` 原文（带行号，逐字引用）· 本 runbook 的规定 · 处理建议。
行号以本文件写作时的工作树版本为准（`docs/qa/release-gate.md` sha256 `969f3c8c34b63ed8ca7761b43c4c9e1f9e881bc94ca59ab5323db5f2ccbfe8cb`）。
**本 runbook 不改 `release-gate.md`**（红线：不改既有的 `docs/qa/*.md`），只在此登记差异，供老板裁定。

### 冲突 1 — 测试套件数量：文档写 16，实际 18

| 项 | 内容 |
|---|---|
| **release-gate.md 原文** | 第 31 行：`- 放行条件：全部测试用例 100% pass，零失败、零报错。`<br>第 14 行（工作流框图内）：`[Gate 1: 单元与策略测试 100% 通过 (bun test)]` |
| **相关第三方文档原文** | `docs/qa/regression-baseline.md` 第 10 行：``- **单测通过率**：`bun test` 16 个测试套件 100% 通过，0 失败，0 挂起。``<br>`docs/qa/evidence-template.md` 第 22 行：``  - `bun test`：16 个测试文件全部通过，共包含 68 个测试用例，运行耗时 1.28 秒，失败用例数：0。`` |
| **本 runbook 的规定** | 套件数以**磁盘实况**为准，不引用任何文档里的数字。判据命令与文件清单见下方 **`Q1-cmd`**（逐字从代码块复制，别从本表格复制）。<br>Gate 1 的放行条件写作「全部套件在 /tmp 副本中跑完，且**非 flaky 清单内**的失败数为 0」；套件数不写进判据，一律现算（写作时 = 18）。 |
| **处理建议** | ① **更正记录**：`release-gate.md` 本身**没有**写过「16」；写过「16 个测试套件」的是 `regression-baseline.md:10`，写过「16 个测试文件」的是 `evidence-template.md:22`。`guard-unit-test-map.md:110` 把「16 个核心测试套件」的出处标成了 `release-gate.md`，属引用串位，一并更正。<br>② 建议把 `regression-baseline.md:10` 的「16 个测试套件」改为「18 个」或改为「以 `find tests -name '*.test.ts'` 为准」，并把文件清单补上新增的 3 个（`accounts_reasons` / `cli_global_flags` / `substitute_core_quota`）与 `evidence-template.md:22` 的「16 个测试文件、68 个测试用例」。<br>③ 在此之前，本 runbook 与 `docs/qa/reports/release-gate-report-latest.md`（第 92 行「18 次逐套件单跑」、第 380 行「18 个套件中仅 2 个触碰生产账本」）一致按 **18** 执行。 |

#### `Q1-cmd` — 套件数与文件清单（现拉）

逐字从下面代码块复制。**别从任何 markdown 表格复制带 `|` 的命令** —— 表格里必须写成 `\|` 才能不把单元格切开，
而 `\|` 会被 shell 当成字面参数，命令**静默失效**。

```bash
find tests -name '*.test.ts' | wc -l
find tests -name '*.test.ts' | sort
```

实测输出（写作时）：

```
18
tests/accounts_reasons.test.ts
tests/calc.test.ts
tests/cli.test.ts
tests/cli_global_flags.test.ts
tests/dashboard.test.ts
tests/db.test.ts
tests/dividend.test.ts
tests/engine.test.ts
tests/multi_account.test.ts
tests/phase2_strategy.test.ts
tests/physics.test.ts
tests/physics_numpy_validation.test.ts
tests/position_view.test.ts
tests/quotes.test.ts
tests/serve_dashboard_dual_mode.test.ts
tests/substitute_core_quota.test.ts
tests/symbol_inference.test.ts
tests/turnover_weighted_force.test.ts
```

### 冲突 2 — 「bun test 100% pass」在隔离环境下不成立（两条 flaky）

| 项 | 内容 |
|---|---|
| **release-gate.md 原文** | 第 31 行：`- 放行条件：全部测试用例 100% pass，零失败、零报错。`<br>第 14 行（工作流框图内）：`[Gate 1: 单元与策略测试 100% 通过 (bun test)]` |
| **相关第三方文档原文** | `docs/qa/guard-unit-test-map.md` 第 77 行：`### 2.1 flaky 观测：隔离环境下有两条用例会偶发失败（非本线映射缺陷）`<br>同文件第 89 行：`#### flaky #1 — physics numpy 位对齐验证（14 次）`<br>同文件第 96 行：`#### flaky #2 — dashboard 额外资产类别柱状卡片配色（2 次）` |
| **本 runbook 的规定** | Gate 1 的放行条件改写为**「非 flaky 清单内失败 = 0」**，并把 flaky 命中如实记录、不折算：<br>① 判据命令与其实测输出见下方 **`Q2-cmd`**（逐字从代码块复制，别从本表格复制 —— 那条命令里有 4 个管道加 1 个写在字符类里的**竖线字符**，从表格复制必失效）。<br>② 允许清单**只有下面这两条**（按用例全名精确匹配）。清单外出现任何一个失败或挂起 → 按 B5 阻断。<br>③ 报告里必须出现「flaky 命中 <N> 次」这一行，并按 R3 声明「本条不构成 Gate 1 通过」。<br>④ 禁止在报告里写「`bun test` 100% pass」这类与隔离环境实测不符的结论。 |
| **处理建议** | ① 建议把 `release-gate.md:31` 的「全部测试用例 100% pass」改为可执行的表述，例如「全部测试用例 pass，**除 §flaky 清单明确列出的两类偶发超时外**，零失败、零报错」，并在文件内附上 flaky 清单与判据命令。<br>② 两条 flaky 建议单独立项修复（都不是产品逻辑缺陷）：flaky #1 是 `HOME` 重定向后 `uv` 冷缓存导致 `uv run --with numpy python3` 首跳实测 **4.230s**（同 HOME 第二次 **0.115s**）撞上 bun 默认 5000ms 单测超时；flaky #2 是 `tests/dashboard.test.ts:146` 起的配色用例（自带 60s 超时，非 5s）。<br>③ 在 flaky 修掉之前，Gate 1 一律在**隔离环境**跑（见冲突 3），否则「100% pass」既不可复现、又会污染生产物件。 |

#### `Q2-cmd` — flaky 命中统计（现拉）

```bash
# 该日志在 L3 的证据目录下（见 guard-unit-test-map.md §2.1）
L3_EVID=docs/qa/evidence/tp-5a3bfad8-L3-20261023-014517-commit-2081243
grep -o 'fail: [^|]*' "$L3_EVID/bun-test-nonpass-observations.log" | sed 's/^fail: //; s/ *$//' | sort | uniq -c | sort -rn
```

实测输出（写作时，与 `guard-unit-test-map.md` §2.1 的记录逐字一致）：

```
  14 Physics Engine & Python NumPy Double-Engine Cross-Validation > 3. 动态 Python NumPy 子进程双引擎实时对账 > 动态调用 Python numpy.polyfit 并在位对齐验证
   2 trade dashboard CLI primitive > localizes extra asset-class pillars and keeps every pillar colour distinct (P3-1 / P3-2)
```

计数与行数的对账（避免把 `16 > 15` 看成异常）：该日志共 **15 行**；含 numpy 用例名的 **14 行**，含 dashboard 用例名的 **2 行**，
其中 **1 行同时命中两条** → 桶计数 `14 + 2 = 16`，行数 `15`。这两个数就是 §2.1 说的「两个不同的偶发失败」。

### 冲突 3 — 能不能在仓库里直接跑 `bun test`：不能，直接跑会刷新生产账本的 `-shm`

| 项 | 内容 |
|---|---|
| **release-gate.md 原文** | 第 30 行：``- 执行命令：`bun test` ``<br>第 29 行：`### Gate 1: 静态与单元基线`<br>第 38 行：``- 测试环境：指定 `TRADE_DB_PATH=/tmp/gate-smoke-$$.db`，绝不触碰生产库。`` |
| **相关第三方证据原文** | `docs/qa/reports/release-gate-report-latest.md` 第 358 行：``核对 Gate 1 时发现 `bun test` 会移动生产库 `~/.trade/trade.db-shm` 的 mtime。``<br>同文件第 380 行：``**18 个套件中仅 2 个触碰生产账本**，两者 `sha256` 均不变。``<br>同文件第 388-392 行（§6.4 机制）：`tests/physics.test.ts:91` / `tests/physics.test.ts:101` / `tests/turnover_weighted_force.test.ts:273` / `tests/turnover_weighted_force.test.ts:284` 四处 `spawnSync`「**不传 `--db`、不设 `LOT_TRADER_DB`/`TRADE_DB_PATH`** → 落到默认生产账本路径」。 |
| **本 runbook 的规定** | ① **绝不在仓库工作树内直接跑 `bun test`**。Gate 1 一律经由 L3 checker 在自建自毁的 `/tmp` 副本里跑：`bun docs/qa/tools/check-guard-unit-map.ts`（其 §4 明文：`checker 自建并销毁 /tmp 沙箱副本；bun test 只在副本内执行，绝不在仓库内跑。`）。<br>② 若必须手工定位某条用例，命令一律写成 `HOME=<临时空目录> bun test tests/<用例>.test.ts`（L3 §4.1 的子进程环境白名单口径），且**不得**在仓库内跑全量套件。<br>③ 生产物件一律以「主库 sha256 + 六表行数 + `-wal` 字节数」为准；`-shm` 的 mtime 前移**不作为**污染判据（只读 WAL 连接的必然副作用）。<br>④ 每次实跑前后仍必须核对生产账本 sha256（见「沙箱规范 · 收尾清理第 3 件」）。 |
| **独立复现（L4 本轮实测，全隔离，留证 `docs/qa/evidence/tp-5a3bfad8-L4-line-20261023-143729/probe-shm-mechanism.txt`）** | 在 `/tmp` 沙箱里复刻了这条链路（`HOME` 与账本都在沙箱；调的是源入口 `bun run src/cli.ts`，即那 4 处 `spawnSync` 的同一条路径），三段观测：<br>· **RUN 1**（沙箱 `$HOME/.trade/` 只有 `trade.db`，sha256 `1ec361a6…ef59`）：执行 `env -u LOT_TRADER_DB -u TRADE_DB_PATH HOME=<沙箱> bun run src/cli.ts physics 518880.SH`（不带 `--db`）→ `exit=0`；沙箱 `.trade/` 内出现 `trade.db-shm`，**size=32768、sha256 `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb`** —— 与生产 `~/.trade/trade.db-shm` 的 sha256 **逐字相同**；`trade.db` sha256 不变（`1ec361a6…ef59`），`trade.db-wal` 新建为 0 字节。<br>· **RUN 2**（静置 3s 后再跑同一条命令）：`trade.db-shm` 的 mtime 由 `14:48:04` 前移到 `14:48:07`，**size 与 sha256 均不变**；`trade.db` mtime 保持 `14:48:04`。即「只读 WAL 连接会前移 `-shm` 的 mtime」被单独复现。<br>· **对照**（同一条命令加 `--db <沙箱>/explicit.db`）：沙箱 `$HOME` 内**没有生成 `.trade/`**（`ls -la` 只有 `Library`）。<br>⇒ 结论：跑一次不带 `--db` 的 `physics` 就会在 `homedir()` 下物化 `~/.trade/trade.db-shm`；无 HOME 重定向的 `bun test` 因此确实会刷新生产账本的 `-shm`（内容不变量仍以 `trade.db`/`-wal` 的 sha256 为准）。 |
| **处理建议** | ① 建议把 `release-gate.md:30` 的 ``- 执行命令：`bun test` `` 改为 `- 执行命令：`bun docs/qa/tools/check-guard-unit-map.ts`（在 /tmp 副本内跑 `bun test`，禁止在仓库工作树内直接跑）`，并在 Gate 1 小节补一句「`bun test` 会经 `tests/physics.test.ts:91/101`、`tests/turnover_weighted_force.test.ts:273/284` 落到默认账本路径，故必须隔离」。<br>② 建议给这 4 处 `spawnSync` 补 `--db /tmp/...`（或设 `LOT_TRADER_DB`），从源头消灭 P3-1；`release-gate-report-latest.md` 第 456 行已把它列为跟踪项 `P3-1`(`T-46`)。<br>③ `release-gate.md:38` 的 `TRADE_DB_PATH=/tmp/gate-smoke-$$.db` 是「只靠环境变量」的口径，比本 runbook 的「显式 `--db` + HOME 重定向 + 三环境变量」弱一档（见冲突 4），建议统一为显式 `--db`。 |

### 冲突 4 — Gate 3 只靠 `TRADE_DB_PATH` 环境变量，且步骤命令不带 `--db`

| 项 | 内容 |
|---|---|
| **release-gate.md 原文** | 第 38 行：``- 测试环境：指定 `TRADE_DB_PATH=/tmp/gate-smoke-$$.db`，绝不触碰生产库。``<br>第 40 行：``  1. 注册账户：`./trade account add CMB_TEST --name "测试账户" --broker CMB` ``<br>第 41 行：``  2. 建仓买入：`./trade lot buy 600519.SH --price 1600 --qty 100 --account CMB_TEST` ``<br>第 43 行：``  4. 止损/止盈扫描：`./trade stats` 与 `./trade position` 数据结构完整；``<br>第 44 行：``  5. 平仓与战绩：`./trade lot close 1 --price 1650 --reason "波段止盈"` 成功更新状态为 CLOSED 并核算出实现收益。`` |
| **本 runbook 的规定** | 每一条 `trade` 调用都必须**显式**带 `--db /tmp/...`，并同时满足 HOME 重定向与三个沙箱环境变量（沙箱规范四项）。只靠 `TRADE_DB_PATH` 是不够的：<br>① 一旦漏传或写错，`src/cli.ts:43-46` 的 `resolveCliDbPath` 会依次回落到 `LOT_TRADER_DB` → `TRADE_DB_PATH` → `DEFAULT_DB_PATH`（`~/.trade/trade.db`），最后落到生产账本；<br>② `TRADE_DB_PATH` 不能保护 `~/.lot-trader/session.token`（那是 `HOME` 的事）；<br>③ 显式 `--db` 让证据文件自证（`.cmd` 里逐字可查），环境变量不在命令串里，取证时无法从命令本身复核。<br>顺带：`--db` 是**全局选项**，出现位置任意（`src/cli.ts:1822`），所以不必也不应把它当成子命令参数。 |
| **处理建议** | 建议把 Gate 3 的 5 条步骤命令全部补上 `--db /tmp/gate-smoke-$$.db`，并把「测试环境」一行改为「`--db` 与 `HOME` 双显式：`--db /tmp/gate-smoke-$$.db`，`HOME=<临时 fakehome>`，`LOT_TRADER_TOKEN_FILE=<fakehome>/.lot-trader/session.token`」。 |

### 冲突 5 — serve 端口：文档用 8081 / 8080，本 runbook 规定 18000–18999

| 项 | 内容 |
|---|---|
| **release-gate.md 原文** | 第 48 行：``- 服务探活：`./trade serve --port 8081 --quiet &`，curl 检查 `/api/health` 返回 `{"status":"ok"}`，终止后台服务。``<br>第 47 行：``- 静态生成：`./trade dashboard --out /tmp/gate-dashboard.html`，检查文件存在且内容包含标的配置与动态脚本。`` |
| **相关第三方文档原文** | `docs/qa/regression-baseline.md` 第 45 行：``  - 本地引擎联动模式：每 3 秒心跳探活 `http://127.0.0.1:8080/api/health`，联通即转绿并对齐本地账本口径；服务关闭后平滑退回自驱模式，全程不报未捕获异常、无白屏、无 `NaN`。``<br>`docs/qa/reports/release-gate-report-latest.md` 第 284 行与第 460 行的原文：两行都是**含单元格分隔符的表格行**，故按本节写法移到下方 **`Q5-quote`** 代码块里逐字引用（若内联进本表格就得转义竖线，那就不再是逐字原文）。 |
| **本 runbook 的规定** | serve 端口只在 **18000–18999** 随机选取（占用则换端口），**不用 8080**、**不用 `--port 0`**，只绑 `127.0.0.1`，停机后须证明端口已释放。<br>理由是取证可复核：8080 是看板模板里写死的探活地址，日常被其它进程占用（macOS 上常见），一旦撞端口本次运行就不可采信；`--port 0` 让内核随机分配，端口号事前不可预知、事后难以复核，且可能落在特权区间或恰好撞上并行线的 serve。<br>因此「看板联动转绿」这一类断言，在 18000–18999 端口下**无法由本 runbook 单独验证** —— 它属于看板模板写死地址的口径问题，本 runbook 记为 BLOCKED（`E2E-N-96` / `E2E-N-97` 两条即为此），不自找变通（如伪造探活地址）。 |
| **处理建议** | ① 建议把 `release-gate.md:48` 的 `--port 8081` 改为 `--port 18xxx`（18000–18999 随机、占用则换）。<br>② 建议把 `regression-baseline.md:45` 的固定 `http://127.0.0.1:8080/api/health` 改为「探活基址可配置（默认 8080，可用 `--port` / 环境变量覆盖）」，并在 `.md` 里注明「18000–18999 为隔离实测端口段」。<br>③ `release-gate.md:47` 的 `./trade dashboard --out /tmp/gate-dashboard.html` 缺少 `--db`，建议一并补上（见冲突 4）—— `src/cli.ts:566-574` 的 `resolveDashboardDb` 同样会回落到 `~/.trade/trade.db`。 |

#### `Q5-quote` — `release-gate-report-latest.md` 的两行表格原文（逐字）

下面两行是从 `docs/qa/reports/release-gate-report-latest.md` 里**逐字**拷出来的完整表格行（含首尾的 `|`，未转义）。
因为本文件的冲突表是 markdown 表格，把这两行内联进去就必须转义竖线、那就不再是逐字原文，所以单独立块：

```
第 284 行：| 联动模式（`serve` on 127.0.0.1:8080） | `/api/health` 200；看板注入凭证；顶栏转「本地引擎行情」 | ✅ |
第 460 行：| **O4** | `/api/health` 未认证回显账本绝对路径 | `curl -s 127.0.0.1:8080/api/health` | 可选改为布尔 `db_present` |
```

### 冲突 6 — Gate 3 的批次 ID 写法与实际 ID 契约不符

| 项 | 内容 |
|---|---|
| **release-gate.md 原文** | 第 42 行：``  3. 防抖加仓拦截：同源在 48h 内执行 `./trade lot add --parent-lot-id 1 --price 1550`，确认必须拦截返回错误码；``<br>第 44 行：``  5. 平仓与战绩：`./trade lot close 1 --price 1650 --reason "波段止盈"` 成功更新状态为 CLOSED 并核算出实现收益。`` |
| **本 runbook 的规定** | 批次 ID 一律使用引擎实际生成的字符串形态 `LOT-<YYYYMMDD>-<NNN>`（`src/engine.ts:330-333`：`.get("LOT-" + dateStr + "-%")` → `const lotId = "LOT-" + dateStr + "-" + seqStr`），例如 `LOT-20261023-001`。<br>本规范下的实跑证据里，`--parent-lot-id` 的实际取值就是 `LOT-20261023-001`（见 `docs/qa/evidence/tp-5a3bfad8-L2-20261023-131915-commit-20812431/E2E-N-41.json` 的第 226、227 步命令）。<br>写 `1` / `2` 这类裸序号**不作为**本规范的可执行命令；需要直接引用批次时必须先取回真实 lot_id。 |
| **处理建议** | 建议把 `release-gate.md:42` 的 `--parent-lot-id 1` 与 `release-gate.md:44` 的 `lot close 1` 改为真实 ID 形态（如 `LOT-20261022-001`），或改成两步写法：先 `./trade lot buy ... --json` 取 `data.lot_id`，再把它代入下一步。 |

### 汇总

| # | 主题 | release-gate.md 相关行 | 是否阻断发布 | 处置 |
|---|---|---|---|---|
| 1 | 套件数量 16 vs 18 | 31（原文列「100% pass」；「16」实际写在 `regression-baseline.md:10`、`evidence-template.md:22`） | 否（文档口径） | 建议更正 2 份文档；执行一律按 18 |
| 2 | 「bun test 100% pass」不成立（2 条 flaky） | 31、14 | 否（flaky 在允许清单内）；清单外失败 → 是（B5） | 建议改写 Gate 1 放行条件为「非 flaky 清单内失败 = 0」+ 附清单 |
| 3 | 仓库内直接跑 `bun test` 会刷新生产账本 `-shm` | 30、29、38 | 是（口径必须遵守，否则隔离结论作废） | 建议 Gate 1 改为经 L3 checker 在 /tmp 副本内跑；建议修 4 处 `spawnSync`（P3-1 / T-46） |
| 4 | Gate 3 只靠 `TRADE_DB_PATH`、步骤命令不带 `--db` | 38、40、41、43、44 | 是（口径必须遵守） | 建议 5 条步骤命令统一补 `--db` + HOME 重定向 |
| 5 | serve 端口 8081/8080 vs 18000–18999 | 48、47；`regression-baseline.md:45` | 是（口径必须遵守）；连带 2 条 BLOCKED | 建议改端口段；建议把看板探活基址改为可配置 |
| 6 | 批次 ID 写法 `1` vs `LOT-<YYYYMMDD>-<NNN>` | 42、44 | 是（命令不可执行即不可复核） | 建议改真实 ID 形态或改两步取 ID |

> 冲突 1、2 属文档口径陈旧，冲突 3、4、5、6 属**执行口径**问题：按本 runbook 执行即可满足隔离与可复核要求，**无需改动 `src/`**。
> 唯一需要改产品/测试代码的是冲突 3 的 `P3-1`（4 处 `spawnSync` 缺 `--db`），已由门禁线列为跟踪项，本规范只登记、不代改。

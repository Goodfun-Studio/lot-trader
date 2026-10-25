# L1 · engine 层校验加固报告（D-09 / D-01 / D-06）

> 本报告与逐案证据同源：`docs/qa/evidence/tp-458199de-L1-20261025-233211-commit-c7d3e52/`（含 `REPORT.md`、`MANIFEST.txt`、逐案 `.cmd/.stdout/.exit/.rows-*`，以及编译产物复验 `BIN-*`）。


- 分支：`line/tp-458199de-L1`
- 基线：主工作树 `main @ c7d3e52`
- 修复提交：`20593653a29de6df2e84f63b3292ea4f320cb004`（short `2059365`）
- worktree：`/tmp/tp-458199de-L1`（所有改动只在该 worktree 内，主工作树未被触碰）
- 环境：Bun 1.3.14 (Darwin arm64)
- 报告对应证据目录：`docs/qa/evidence/tp-458199de-L1-20261025-233211-commit-c7d3e52/`（下称 `<EV>`）

---

## 0. 结论

三条缺陷全部修复，且**每条拦截都配了「合法入参不误伤」的负向断言**（本节 §3 逐条给了证据路径）。

- `bun test`（全量）：**208 pass / 0 fail / 2283 expect() calls**，19 个测试文件。基线（c7d3e52）为
  192 pass / 0 fail，本线新增 `tests/l1_engine_input_guards.test.ts` 16 条用例，净 +16。
- 改动范围：`src/engine.ts`（唯一产品代码文件）+ `tests/`（新增 1 个文件、改写 3 个文件的
  受 D-01 影响的用例）+ 2 个 QA 文档的事实更正。**未触碰 `src/cli.ts`、未触碰 `scripts/`。**
- 主账本隔离：`~/.trade/trade.db` 与 `~/.lot-trader/` 在开工前/收工后逐字节一致（§5）。

---

## 1. 三个缺陷的修复实现

### D-09（P0）价格必须是有限正数

新增模块级导出 `assertLegalFillPrice(price, context)`：

```
typeof price !== "number" || !Number.isFinite(price) || price <= 0
  -> throw new Error("非法成交价：<context> 必须为有限正数 (> 0，且非 NaN / Infinity)，当前输入: <v>，已拒绝写入账本")
```

守卫点（三个入口，全部在**任何落库动作之前**，即早于账户自愈 `ensureAccount()` 与事务）：

| 入口 | 位置 | context 文案 |
|---|---|---|
| `lot buy` | `buyLot()` 顶部，`normalizeSymbol` 之后第一件事 | 买入成交价 |
| `lot add` | `addLot()` 顶部、**在 `amount / price` 换算股数之前** | 加仓成交价 |
| `lot close` | `TraderEngine.closeLot()` 包装层，委派 `LotCloser` 之前 | 平仓成交价 |

`lot add` 的守卫位置很关键：旧路径 `price = 0` 时 `Math.floor(amount / 0 / 100) * 100 = Infinity`，
`price = NaN` 时得到 `NaN` 股数，随后报出误导性的「100 的整数倍」错误（或直接落库）。现在会
在换算前就以「非法成交价」终止。

### D-01（P0）48h 防抖守卫改真实时钟 + 拒绝未来成交时间

- 冷却窗口判定改用**真实时钟**：`buyLot()` 里新增 `const realNow = new Date();`，血缘防抖调用
  由 `this.checkLineageAntiShake(parentLotId, now)` 改为 `this.checkLineageAntiShake(parentLotId, realNow)`。
  `checkLineageAntiShake` 的 doc 注释明确写成「`now` MUST be the real wall clock」。
  （48h 阈值与 `pyramid_level > 0` 判定逻辑本身未改，仍是 `diffMs >= 0 && diffMs < cooldownMs`。）
- 新增模块级导出 `assertFillTimeNotInFuture(fillTime, realNow, context)`：
  - `fillTime` 无法解析（Invalid Date）→「非法成交时间：… 无法解析为有效时间戳，已拒绝写入账本」；
  - `fillTime > realNow` →「成交时间不得晚于当前时间：… 传入 <t> 晚于当前 <now>，已拒绝写入账本」。
  - 三个入口都挂：`buyLot`（买入成交时间）、`addLot`（加仓成交时间）、`closeLot`（平仓成交时间）。
- 过去时间的回填**完全保留**：`--time` 是历史录入功能，只禁止「晚于当前」。

### D-06（P3）硬顶拦截文案占比可区分

新增模块级导出 `formatPositionCapRatio(ratio)` = `(ratio * 100).toFixed(4) + "%"`，两个分支
（带预算 / 不带预算）统一改用；阈值文案仍是 `30.00%`，拦截判定 `ratio > 0.3000 + 1e-6` 未动。

由于判定门槛就是 `30.0001%`，4 位小数保证**任何触发拦截的值显示出来都 ≥ `30.0001%`**，与
`30.00%` 不再同值。原文档复现值 `3000.50 / 10000.50` 现在显示为 `30.0035%`（旧为 `30.00%`）。

---

## 2. 硬性隔离与主账本零污染

| 观测点 | 证据 |
|---|---|
| 开工前 `~/.trade/trade.db` | `1ec361a6474809794841591a5f83bbf042c0159de1536fbed379ce568a2aef59` — `<EV>/LEDGER-ISOLATION-before.txt` |
| 收工后 `~/.trade/trade.db` | `1ec361a6474809794841591a5f83bbf042c0159de1536fbed379ce568a2aef59` — `<EV>/LEDGER-ISOLATION-after.txt` |
| `~/.lot-trader/` 开工前/后 | 均只有 `session.token.stale-bak`（65 字节，mtime 未变）— `<EV>/LOT-TRADER-DIR-before.txt` / `-after.txt` |

每次 trade 调用都是 `HOME=/tmp/tp-458199de-L1/fakehome env -u LOT_TRADER_DB -u TRADE_DB_PATH bun run src/cli.ts … --db /tmp/tp-458199de-L1/db/<名字>.db`，
六表行数用 `sqlite3` 直接读账本文件（证据里的 `*.rows-before.txt` / `*.rows-after.txt`）。
测试进程内的 CLI 用例同样把子进程 `HOME` 重定向到临时目录并剥掉两个默认账本环境变量。

---

## 3. 验收标准 → 证据对应表

### 3.1 watcher 指定要落的四类证据

**(1) `grep -n "48 \* 3600\|cooldownMs\|isFinite\|Number.isFinite" src/engine.ts`** → `<EV>/GREP-ENGINE-GUARDS.txt`

```
24:  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
286:    const cooldownMs = 48 * 3600 * 1000; // 48 hours (2 trading days)
294:        if (diffMs >= 0 && diffMs < cooldownMs) {
295:          const hoursLeft = ((cooldownMs - diffMs) / (3600 * 1000)).toFixed(1);
914:    if (!isFinite(amount) || amount <= 0) {
```

（第 24 行是 D-09 的价格守卫，第 286~295 行是 D-01 的 48h 冷却判定，第 914 行是 `addDividend` 既有的
金额校验，与本线无关。）

**(2) 新增单测全部用例名 + `bun test` 输出尾部** → `<EV>/L1-TEST-CASE-NAMES.txt`、`<EV>/BUN-TEST-L1-GUARDS.txt`、`<EV>/BUN-TEST-FULL.txt`

`tests/l1_engine_input_guards.test.ts` 共 16 条用例：

```
describe("L1 D-09: ledger prices must be finite positive numbers")
  engine: lot buy rejects every non-finite / non-positive price with zero ledger writes
  engine: lot add rejects every illegal price BEFORE deriving quantity from amount/price
  engine: lot close rejects every illegal price with zero ledger writes
  CLI NEGATIVE CONTROL: abc / 0 / -2.5 buys all exit non-zero and write nothing
  CLI NEGATIVE CONTROL: illegal prices on lot add and lot close are refused with zero writes
  CLI POSITIVE CONTROL: legal prices 2.0001 and 8.199 are never mis-killed (lots+1, trades+1, cost_basis_unit == price)
  engine POSITIVE CONTROL: 2.0001 buy keeps cost_basis_unit === buy_price
describe("L1 D-01: anti-shake cooldown runs on the real clock and refuses future fill times")
  engine: future fill time is refused on buy, add and close with zero writes
  engine: an unparseable --time is refused instead of inserting a NaN-stamped row
  engine: a forged future time can no longer bypass the cooldown on a blocked lineage
  engine POSITIVE CONTROL: history-backfilled pyramid add outside the window is allowed (parent -72h, first add -49h, next add on the real clock)
  CLI NEGATIVE CONTROL: --time in the future exits non-zero and writes nothing
  CLI POSITIVE CONTROL: a -49h backfilled add is accepted and the row is inserted
describe("L1 D-06: 30% hard-cap message prints a ratio distinguishable from the threshold")
  engine: interception still fires, zero writes, and the printed ratio is not '30.00%'
  CLI: over-cap buy exits 1, mutates nothing, and the ratio is readable (30.0035% > 30.00%)
  CLI POSITIVE CONTROL: a buy that stays under the cap is still accepted
```

```
$ bun test tests/l1_engine_input_guards.test.ts
 16 pass
 0 fail
 109 expect() calls
Ran 16 tests across 1 file. [946.00ms]

$ bun test
 208 pass
 0 fail
 2283 expect() calls
Ran 208 tests across 19 files. [18.82s]
```

**(3) 三次违规调用 + 两次合法调用的完整命令 / exit 码 / 调用前后六表行数** → 每个案例一组
`<EV>/<CASE>.cmd|.stdout|.stderr|.exit|.rows-before.txt|.rows-after.txt`，由 `<EV>/EVIDENCE-HARNESS.sh` 生成。

| 案例 | 预期 | 实测 exit | 六表行数（前 → 后） | 判定 |
|---|---|---|---|---|
| `LEGAL-BUY-2.0001`（合法 #1，`--fee 0`） | 放行 | 0 | `accounts=2 lots=1 trades=1 symbols=18`（账本首次创建） | 通过；`cost_basis_unit == 2.0001` |
| `BUY-PRICE-NAN`（`--price abc`） | 拦截 | 1 | `… lots=1 … trades=1 …` → 同值 | 通过；Δ **0** |
| `BUY-PRICE-ZERO`（`--price 0`） | 拦截 | 1 | 同上 → 同值 | 通过；Δ **0** |
| `BUY-PRICE-NEG`（`--price -2.5`） | 拦截 | 1 | 同上 → 同值 | 通过；Δ **0** |
| `ADD-PRICE-NAN`（`lot add --price abc --amount 10000`） | 拦截 | 1 | 同上 → 同值 | 通过；Δ **0** |
| `CLOSE-PRICE-NEG`（`lot close --price -2.5 --qty 100`） | 拦截 | 1 | 同上 → 同值 | 通过；Δ **0** |
| `ADD-TIME-FORGERY`（`lot add --time now+50h`） | 拦截 | 1 | 同上 → 同值 | 通过；Δ **0** |
| `BUY-TIME-FORGERY`（`lot buy --time now+50h`） | 拦截 | 1 | 同上 → 同值 | 通过；Δ **0** |
| `LEGAL-BUY-8.199`（合法 #2，`--fee 0`） | 放行 | 0 | `lots=1 trades=1` → `lots=2 trades=2` | 通过；`cost_basis_unit == 8.199` |
| `LEGAL-BUY-BACKFILL-72H`（合法 #3a） | 放行 | 0 | `lots=2` → `lots=3` | 通过 |
| `LEGAL-ADD-BACKFILL-49H`（合法 #3b，`--time -49h`） | 放行 | 0 | `lots=3` → `lots=4`，`pyramid_level=1` | 通过 |
| `D06-OTHER-PARK`（D-06 铺垫，另起 `d06.db`） | 放行 | 0 | `lots=1 trades=1` | 通过 |
| `D06-OVER-CAP` | 拦截 | 1 | `lots=1 trades=1` → 同值 | 通过；Δ **0**，文案 `30.0035%` |
| `D06-UNDER-CAP` | 放行 | 0 | `lots=1` → `lots=2` | 通过（硬顶未误杀线内买入） |

违规侧文案（`stdout`，`--json` 模式）：

```
BUY-PRICE-NAN    {"code":1,"msg":"非法成交价：买入成交价 必须为有限正数 (> 0，且非 NaN / Infinity)，当前输入: NaN，已拒绝写入账本",…}
BUY-PRICE-ZERO   {"code":1,"msg":"非法成交价：买入成交价 必须为有限正数 …当前输入: 0…"}
BUY-PRICE-NEG    {"code":1,"msg":"非法成交价：买入成交价 必须为有限正数 …当前输入: -2.5…"}
ADD-PRICE-NAN    {"code":1,"msg":"非法成交价：加仓成交价 必须为有限正数 …当前输入: NaN…"}
CLOSE-PRICE-NEG  {"code":1,"msg":"非法成交价：平仓成交价 必须为有限正数 …当前输入: -2.5…"}
ADD-TIME-FORGERY {"code":1,"msg":"成交时间不得晚于当前时间：加仓成交时间 传入 2026-10-27T17:32:11.000Z 晚于当前 2026-10-25T15:32:11.825Z，已拒绝写入账本"}
BUY-TIME-FORGERY {"code":1,"msg":"成交时间不得晚于当前时间：买入成交时间 传入 … 晚于当前 …"}
D06-OVER-CAP     {"code":1,"msg":"单标的持仓硬顶风控拦截：买入后标的 159915.SZ 估算持仓占比为 30.0035%，超过 30.00% 组合级硬顶红线 (标的总额 3000.50 / 组合总值 10000.50)！"}
```

**(4) 改写的 phase2 用例 diff** → `<EV>/PHASE2-REWRITE.diff`（全量 diff 另见 `<EV>/TESTS-ALL.diff`）

改写原则：**没有删除任何用例、没有放宽任何断言、没有加 skip**，只把「靠未来成交时间绕过窗口」的
写法改成「真实时钟口径 + 过去时间回填」。两处：

1. `pyramid dip add: …`（原 `:29/:43` 的 `now+50h` / `addTime+50h`）→ 父批次回填 `-72h`、
   首笔加仓 `-49h`、第三次加仓**不传 `--time`**（真实时钟距上一档 49h > 48h）。所有断言原样保留
   （`parent_lot_id` / `pyramid_level` 1→2 / `buy_price` 5.40 / `buy_quantity` 1800 / `status`）。
2. `lineage guard: anti-shake cooldown intercepts …`（原 `:54` 那条，任务点名的 G-21 违规侧）
   → 根批次回填 `-120h`、首笔加仓真实 `-1h`（血缘里当时还没有非根批次，合法放行），
   随后两次加仓**不传 `--time`**，断言仍 `toThrow("防抖冷却窗口守卫拦截")`；窗口外侧改用
   `-72h / -49h / 不传 --time` 的新血缘，断言 `pyramid_level = 2`。

同一原因（D-01 修复后未来成交时间必须被拒）还必须改写的其它既有用例，都在**保留断言**的前提下
改成过去时间：`tests/multi_account.test.ts`（原 `now+49h` / `now+100h` → `-49h` / `-24h`）、
`tests/accounts_reasons.test.ts`（原 `now+49h` → `-49h`）。若不改，它们会在修复后 100% 失败——
它们的「通过」此前正是靠 D-01 的缺口。

### 3.2 负向防误杀（本线验收核心）

| 要求 | 证据 |
|---|---|
| 合法价格 `2.0001` 建仓 exit 0、`lots+1`、`trades+1`、`--fee 0` 时 `cost_basis_unit == 买入价` | `<EV>/LEGAL-BUY-2.0001.{stdout,exit,rows-*}`；单测 `CLI POSITIVE CONTROL: legal prices 2.0001 and 8.199…` |
| 合法价格 `8.199` 同上 | `<EV>/LEGAL-BUY-8.199.{stdout,exit,rows-*}` |
| 冷却窗口外的历史回填加仓放行（父 `-72h`、首笔 `-49h`、第三次不传 `--time`），子批次 `pyramid_level = 父 + 1` | `<EV>/LEGAL-BUY-BACKFILL-72H.*`、`<EV>/LEGAL-ADD-BACKFILL-49H.*`（`"pyramid_level": 1`）；单测 `engine POSITIVE CONTROL: history-backfilled pyramid add outside the window is allowed` 与 `CLI POSITIVE CONTROL: a -49h backfilled add is accepted…` |
| `phase2_strategy.test.ts:54`（G-21）用例改写为真实时钟合法侧，不得删除/放宽/skip | `<EV>/PHASE2-REWRITE.diff`；改写后该用例仍在，断言仍 `toThrow("防抖冷却窗口守卫拦截")` 与 `expect(lotL2.pyramid_level).toBe(2)` |
| 硬顶拦截用例：拦截仍成立 + 零写入 + 文案可区分 | `<EV>/D06-OVER-CAP.{stdout,exit,rows-*}`（exit 1、Δ 0、`30.0035%` vs `30.00%`）；单测 `engine: interception still fires…` 与 `CLI: over-cap buy exits 1…` |
| 额外的合法侧（硬顶未误杀线内买入） | `<EV>/D06-UNDER-CAP.*`（exit 0、`lots+1`）；单测 `CLI POSITIVE CONTROL: a buy that stays under the cap is still accepted` |

单测里对每个拦截还用 `engineCounts(engine)` 断言 `accounts/lots/signals/trades/dividends/symbols`
六表**逐表行数不变**（引擎级零写入，不只是 CLI 级）。

### 3.3 全量回归

`bun test`：208 pass / 0 fail / 2283 expect() calls（19 文件）。基线 192 pass / 0 fail。

> 说明（诚实披露）：本线在并发多线负载下观察到 2 次**其它文件**的 CLI 子进程用例瞬时失败
> （`trade dashboard CLI primitive > localizes extra asset-class pillars…`、`Position / Holding…
> > 5. validates CLI 'trade position'…`），单独重跑与随后 9 次全量重跑均 0 fail；基线 worktree
> （`/tmp/tp-458199de-base @ c7d3e52`）4 次全量运行 0 fail，`tests/position_view.test.ts` 单独
> 连跑 10 次 0 fail。判定为机器级并发负载抖动，与本线改动无关（本线改动只在 `buyLot/addLot/closeLot`
> 的入参校验上，且这些用例的入参全部合法）。

---

## 4. 改动文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/engine.ts` | 产品代码 | D-09 / D-01 / D-06 三处修复 + 3 个导出守卫/格式化函数 |
| `tests/l1_engine_input_guards.test.ts` | 新增单测 | 16 条用例（违规侧 + 合法侧对照，引擎级 + CLI 级） |
| `tests/phase2_strategy.test.ts` | 改写单测 | 2 条受 D-01 影响的用例改写为真实时钟口径（断言全保留） |
| `tests/multi_account.test.ts` | 改写单测 | 未来成交时间 → 过去时间（断言全保留） |
| `tests/accounts_reasons.test.ts` | 改写单测 | 未来成交时间 → 过去时间（断言全保留） |
| `docs/qa/guard-unit-test-map.md` | 文档更正 | G-21 由 `GAP` 转 `MAPPED`（指向新用例）；G-19/G-20 描述改为 `-49h` 回填口径；G-15/G-19/G-20/G-23/G-30/G-31 的 phase2 行号随改写更新；§GAP 汇总表 G-21 行标注已闭合 |
| `docs/qa/user-operation-matrix.md` | 文档更正 | §14.1 的 D-01 / D-06 / D-09 各加一段「修复状态」；§11 守卫表的原始观测值保持原样（作为缺陷期的审计记录） |

**未触碰**：`src/cli.ts`（L2 线）、`scripts/`（L3 线）。

### 留给 L2 线的参数解析层缺口（本线按约定不改）

1. `parseFloat(priceArg)` 之后的 `NaN` 现在由引擎拒绝，但 CLI 层仍在 `--price` 缺省/非法时不做
   任何校验，错误文案统一是引擎侧的「非法成交价」而非参数级文案；建议 L2 在参数解析处补统一提示。
2. `values.time ? new Date(values.time) : undefined`：`new Date("abc")` 得到 Invalid Date，
   现在由引擎的「非法成交时间」挡住。若 L2 想在 CLI 层给出更友好的参数错误，可与引擎守卫并存。
3. `--fee` 非法值（如 `--fee abc`→NaN）目前**不**走价格守卫，会以 `NaN` 写入 `buy_fee` /
   `cost_basis_unit`（属价格守卫的同类缺口，但不在本线三条缺陷范围内，故未擅自扩大改动）。
4. `--qty abc` → `parseInt` 得 `NaN`，`quantity <= 0` 与 `% 100` 判断都会漏过（`NaN <= 0` 为
   false、`NaN % 100 !== 0` 为 true），最终会被「100 的整数倍」挡住，文案可用性属参数层问题。

---

## 5. 证据文件索引（`<EV> = docs/qa/evidence/tp-458199de-L1-20261025-233211-commit-c7d3e52/`）

| 验收项 | 证据文件 |
|---|---|
| 环境/提交 | `MANIFEST.txt` |
| grep 守卫锚点 | `GREP-ENGINE-GUARDS.txt` |
| 新单测用例名 | `L1-TEST-CASE-NAMES.txt` |
| 单测输出（新文件 / 全量） | `BUN-TEST-L1-GUARDS.txt`、`BUN-TEST-FULL.txt` |
| 引擎 diff / 测试 diff / phase2 diff | `ENGINE-D-09-D-01-D-06.diff`、`TESTS-ALL.diff`、`PHASE2-REWRITE.diff`、`DIFF-STAT.txt` |
| 主账本隔离 | `LEDGER-ISOLATION-before.txt`、`LEDGER-ISOLATION-after.txt`、`LOT-TRADER-DIR-before.txt`、`LOT-TRADER-DIR-after.txt` |
| 违规/合法调用逐案证据 | `<CASE>.cmd` / `.stdout` / `.stderr` / `.exit` / `.rows-before.txt` / `.rows-after.txt` |
| 证据可复现 | `EVIDENCE-HARNESS.sh`（生成上述全部 `*.cmd`/`*.exit`/`*.rows-*`） |

---

## 6. 编译产物 `./trade` 复验（与源码路径等价）

`bun build --compile src/cli.ts --outfile trade` 在 worktree 内重新编译出 63,627,746 字节的
`./trade`（sha256 `fd9c82a6276b987ac4e8fe6679757b8063295496e03c1202ebaadc36939f4d7d`，见
`BIN-ARTIFACT.txt`），并用**该二进制**重跑了关键 8 条调用（`BIN-*.{cmd,stdout,stderr,exit,rows-*}`），
结论与 `bun run src/cli.ts` 路径完全一致：

| 案例 | exit | 六表 Δ | 备注 |
|---|---|---|---|
| `BIN-LEGAL-BUY-2.0001` | 0 | `lots`+1、`trades`+1 | `cost_basis_unit == 2.0001` |
| `BIN-BUY-PRICE-NAN` / `ZERO` / `NEG` | 1 / 1 / 1 | 0 | 均「非法成交价」 |
| `BIN-ADD-PRICE-NAN` | 1 | 0 | 「非法成交价：加仓成交价 …」 |
| `BIN-CLOSE-PRICE-NEG` | 1 | 0 | 「非法成交价：平仓成交价 …」 |
| `BIN-ADD-TIME-FORGERY` | 1 | 0 | 「成交时间不得晚于当前时间：加仓成交时间 …」 |
| `BIN-LEGAL-BUY-8.199` | 0 | `lots`+1、`trades`+1 | `cost_basis_unit == 8.199` |

二进制复验结束后主账本哈希仍为 `1ec361a6…59`（`LEDGER-ISOLATION-after-binary.txt`），
`~/.lot-trader/` 仍只有 `session.token.stale-bak`。
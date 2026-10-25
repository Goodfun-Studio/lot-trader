# 守卫 → bun 单测映射表（L3 `line-qa-guard-unit-map`）

话题：tp-5a3bfad8 · lot-trader 用户操作全集梳理与 E2E 质检测试流程设计
守卫来源：`docs/qa/user-operation-matrix.md` §11 守卫清单（G-01 ~ G-45，共 45 条）
被测对象：仓库 `/Users/ivywu/Downloads/GitHub/Goodfun-Studio/lot-trader`，HEAD `2081243`，`./trade` sha256 `3d275c9428a737243cb454dc60d33320a51318220e57c382066b1f50e13462bd`

## 0. 本表的判定口径

一条守卫被标为 `MAPPED`，当且仅当存在一条 bun 单测同时满足：

1. **输入合法**：该用例喂进去的值，在这条守卫的规则下是允许的（不是违规侧样本）；
2. **断言放行或保持正常状态**：断言的是成功、`exit 0`、状态保持 `ACTIVE`、无告警、`200`、不报 missing 之类的正向结论；
3. **落在被测守卫的判定路径上**：该用例确实会走到这条守卫的判断分支。

只断言「违规被拦」的用例、或输入与该守卫无关的用例，一律不映射。守卫在逻辑上不存在合法侧（纯性质断言）时标 `GAP`，原因写明「无合法侧：…」。
`GAP` 行不写单测代码，只写一句补测建议；本线不改 `tests/`。

## 1. 映射表

| G-ID | 状态 | 测试文件 | 用例名（describe > it） | 行号 | 断言原文摘录 | 合法输入说明 | 隔离运行结果 |
|---|---|---|---|---|---|---|---|
| G-01 | GAP | — | — | — | — | 原因：G-01 是 QA 采集器的执行前守卫（拒绝未带 `--db` 或 HOME 越界的调用），属质检测试脚手架而非产品代码，`tests/` 无对应单测。 ｜ 建议补测：把采集器守卫抽成可导入函数后补一条「沙箱 HOME 的调用被接受、越界 HOME 被拒绝」的对照单测。 | — |
| G-02 | MAPPED | tests/cli_global_flags.test.ts | CLI --db <path> is honoured by every subcommand > routes lot buy/list, account list, stats and scan to the --db sandbox only | 210 | expect(buy.exitCode).toBe(0); | 显式 `--db <沙箱>`，同时把 `LOT_TRADER_DB` / `TRADE_DB_PATH` 指向敌意默认账本；合法输入被放行（exit 0、批次落库），并证明 `--db` 胜过环境变量、默认账本未被创建。 | pass |
| G-03 | MAPPED | tests/cli_global_flags.test.ts | CLI --db <path> is honoured by every subcommand > keeps the environment-variable path working when no --db is given | 285 | expect(buy.exitCode).toBe(0); | 不带 `--db`、只给 `LOT_TRADER_DB`（合法的环境变量回退路径）；exit 0 且该路径账本被创建。`TRADE_DB_PATH` 回退由 tests/symbol_inference.test.ts:53 单独覆盖。 | pass |
| G-04 | MAPPED | tests/serve_dashboard_dual_mode.test.ts | trade serve: port conflict and lifecycle guards > refuses to bind a non-loopback host so the ledger never leaves the machine | 1851 | expect(resolveServeHost("localhost")).toBe("127.0.0.1"); | 合法回环别名 `localhost` / `127.0.0.1` / `::1`；断言全部被解析为回环地址（未误杀），同用例再断言非回环地址被拒。 | pass |
| G-05 | MAPPED | tests/serve_dashboard_dual_mode.test.ts | trade serve: local session credential gate (0600 token) > writes a 64-hex credential file with 0600 and nothing wider | 1461 | expect(statSync(tokenFile).mode & 0o777).toBe(0o600); | 自动生成会话凭据的正常启动；断言凭据文件权限恰为 0600、内容为 64 位十六进制，合法启动未被误伤（含被 chmod 0644 后重写仍回落 0600）。 | pass |
| G-06 | MAPPED | tests/serve_dashboard_dual_mode.test.ts | trade serve: local session credential gate (0600 token) > accepts the Bearer header and the ?token= channel with identical full payloads | 1569 | expect(viaHeader.status).toBe(200); | 携带正确 Bearer 凭据的合法请求；断言 200 且拿到完整账本载荷，鉴权门未误杀合法客户端（`?token=` 通道同样 200）。 | pass |
| G-07 | GAP | — | — | — | — | 无合法侧：G-07 约束的是 401 失败响应体不得出现任何账本字段，属失败分支的纯性质断言，不存在「合法输入」这一侧。 ｜ 建议补测：在现有 401 用例旁补一条正向对照，断言同一端点的 200 响应体确实含 `total_cost` 等字段，以证明该 401 断言不是恒真。 | — |
| G-08 | MAPPED | tests/serve_dashboard_dual_mode.test.ts | trade serve: network security guards (CORS allow-list + DNS rebinding) > accepts loopback Host variants and Origin-less CLI clients with no CORS leakage | 1294 | expect(resp.status, `Host ${okHost} must be served`).toBe(200); | 合法回环 Host（`127.0.0.1:port` / `localhost:port` / `[::1]:port` / `127.0.0.1`）与无 Origin 的 CLI 请求；断言 200 正常服务且不凭空产生 CORS 头。 | pass |
| G-09 | MAPPED | tests/serve_dashboard_dual_mode.test.ts | trade serve: network security guards (CORS allow-list + DNS rebinding) > still serves the file:// dashboard (Origin: null) and loopback origins (anti-false-positive) | 1270 | expect(resp.status, `Origin ${sent} must be served`).toBe(200); | 合法来源 `Origin: null`（file:// 看板）与回环来源共 5 组；断言 200 并回显对应 allow-origin，白名单守卫未误杀合法来源。 | pass |
| G-10 | MAPPED | tests/serve_dashboard_dual_mode.test.ts | trade serve: local session credential gate (0600 token) > OPTIONS preflight from a legal Origin allows the Authorization header without a token | 1645 | expect(preflight.status).toBe(204); | 合法来源的浏览器预检（按规范不带凭据）；断言 204 且回放 `Authorization` 到 allow-headers，预检路径未被鉴权门误杀。 | pass |
| G-11 | MAPPED | tests/serve_dashboard_dual_mode.test.ts | trade serve: local HTTP engine contract > GET /api/lots supports symbol / account / status filters | 838 | expect(all.status).toBe("ok"); | 合法端点与合法筛选参数（`symbol` / `account` / `status`）；断言 200 载荷 `status: ok` 并返回全部批次，未知端点守卫未误杀正常读请求。 | pass |
| G-12 | MAPPED | tests/serve_dashboard_dual_mode.test.ts | trade serve: port conflict and lifecycle guards > shuts down gracefully on SIGTERM, frees the port and drops the generated credential | 1958 | expect(exitCode).toBe(0); | 正常运行中的 `serve` 收到 SIGTERM（合法停机信号）；断言进程退出码 0、端口释放、自动生成凭据被删除，停机路径未被误伤。 | pass |
| G-13 | MAPPED | tests/serve_dashboard_dual_mode.test.ts | trade serve: local session credential gate (0600 token) > keeps an explicitly supplied token and never deletes the owner's credential file | 1667 | expect(existsSync(tokenFile)).toBe(true); | 显式提供 `--token` 且外部凭据文件已存在（合法用法）；断言停服后该外部文件仍在、内容不变，合法凭据文件未被误删。 | pass |
| G-14 | MAPPED | tests/serve_dashboard_dual_mode.test.ts | trade serve: degraded ledger guards (empty book is never assumed) > NEGATIVE anti-false-positive: a healthy seeded ledger is not degraded | 973 | expect(summary.degraded).toBe(false); | 结构健康的正常账本（有成交流水也有在场批次）；断言 `degraded=false` 且 `degraded_reason=null`，降级判定未误报。 | pass |
| G-15 | MAPPED | tests/phase2_strategy.test.ts | Phase 2 Core Strategy Logic Tests > position cap & risk guard: blocks purchases exceeding 30% single-symbol limit | 172 | expect(lot2.symbol).toBe("600519.SH"); | 在 100,000 元组合预算下买入 25,000 元第二个标的（占比 25.00% < 30.00%）；断言建仓成功，硬顶守卫未误杀线下标的。 | pass |
| G-16 | GAP | — | — | — | — | 原因：无单测落在「买入后占比恰好 30.00% 放行」这条线上——现有硬顶单测只取 19.8% / 25% / 73.5% 与超限值，边界完全空白。 ｜ 建议补测：在 100,000 元预算下买入恰好 30,000 元（占比 30.00%）的 `buyLot` 用例并断言不抛错。 | — |
| G-17 | MAPPED | tests/cli.test.ts | CLI End-to-End Tests > runs full lot lifecycle via CLI with JSON output and tables | 78 | expect(p6.exitCode).toBe(0); | 显式传入跳过风控参数 `--skip-risk` 的 `lot add`（合法旁路参数）；断言 exit 0 且子批次 `pyramid_level=1` 正常落库，旁路参数未被误拒。 | pass |
| G-18 | MAPPED | tests/position_view.test.ts | Position / Holding Aggregated View Tests > 1. calculates weighted average cost price and total quantity across multiple lots for a single symbol | 51 | expect(p.active_lots_count).toBe(2); | 同一标的连续两次建仓（1000 股 @10.00 与 2000 股 @8.00，累计成本 26,001.30 元）且组合内无其他标的；断言两笔都成为在场批次，证明该硬顶是跨标的组合窗口口径、不是单标的绝对金额上限。 | pass |
| G-19 | MAPPED | tests/phase2_strategy.test.ts | Phase 2 Core Strategy Logic Tests > pyramid dip add: correctly inherits lineage, calculates amount, and increments pyramid level | 51 | expect(addedLot2.pyramid_level).toBe(2); | 第二次加仓（父批次已是 L1 子批次，上一档成交时间回填 -49h，合法落在 48 小时冷却窗口之外，本次不传 `--time` 由真实时钟判定）。此时血缘链里已有 `pyramid_level=1` 的批次，输入真正走到 `checkLineageAntiShake` 的冷却判定分支（src/engine.ts:291-300 的 `pyramid_level > 0` 循环）；断言放行且层级递增为 2，防抖守卫未误杀窗口外加仓。 | pass |
| G-20 | MAPPED | tests/phase2_strategy.test.ts | Phase 2 Core Strategy Logic Tests > pyramid dip add: correctly inherits lineage, calculates amount, and increments pyramid level | 50 | expect(addedLot2.parent_lot_id).toBe(addedLot.lot_id); | 冷却窗口外的第二次加仓；断言子批次被正常创建且父链继承自上一档（同用例 @51 断言 `pyramid_level` 由 1 递增为 2），守卫未误拦窗口外加仓。 | pass |
| G-21 | MAPPED | tests/l1_engine_input_guards.test.ts | L1 D-01: anti-shake cooldown runs on the real clock and refuses future fill times > engine POSITIVE CONTROL: history-backfilled pyramid add outside the window is allowed (parent -72h, first add -49h, next add on the real clock) | 358 | expect(second.pyramid_level).toBe(2); | 合法侧＝真实时钟下已过窗口的加仓：父批次回填 -72h、首笔加仓 -49h，第三次加仓不传 `--time`（真实时钟距上一档 49h > 48h）；断言放行且 `pyramid_level = 父 + 1`。同文件另配违规侧两条：`engine: future fill time is refused on buy, add and close with zero writes`（买/加/平三入口均断言抛错且六表行数不变）与 `CLI NEGATIVE CONTROL: --time in the future exits non-zero and writes nothing`（exit≠0、零写入、文案含「不得晚于当前」）。D-01 修复后（`line/tp-458199de-L1`）本行由 GAP 转 MAPPED。 | pass |
| G-22 | MAPPED | tests/engine.test.ts | Trader Engine > validates lot buy parameters correctly | 26 | expect(lot.lot_id.startsWith("LOT-")).toBe(true); | 合法数量 2000 股（100 的整数倍且为正数）；断言建仓成功并返回 `LOT-` 前缀批次号，股数守卫未误杀合法入参。 | pass |
| G-23 | MAPPED | tests/phase2_strategy.test.ts | Phase 2 Core Strategy Logic Tests > partial close: preserves ACTIVE status, maintains cost basis, and stats multi-attribution | 200 | expect(updated1.remaining_quantity).toBe(2000); | 对 3000 股批次平仓 1000 股（合法不超过剩余可用量）；断言平仓成功、余量正确递减为 2000，数量守卫未误杀合法平仓。 | pass |
| G-24 | GAP | — | — | — | — | 原因：`tests/` 无任何「`trade lot close --account <正确账户>`」用例，账户归属守卫的合法侧（CLOSE-ACCT-OK）与违规侧都没有单测入口（账户比对在 CLI 层，`engine.closeLot` 不收账户参数）。 ｜ 建议补测：补一条 CLI 用例：批次属 ACCA 时用 `--account ACCA` 平仓断言 exit 0、用 `--account ACCB` 断言 exit 1 且不落库。 | — |
| G-25 | MAPPED | tests/engine.test.ts | Trader Engine > scene c: stock core substitution day trade | 120 | expect(updatedLot.substituted_core_lot_id).toBe(coreLot.lot_id); | 账户内有前日底仓（500 股 600519.SH）时卖出当日新买批次；断言代冲成功、批次 CLOSED 且记录到底仓批次号，T+1 守卫未误杀有底仓的合法卖出。 | pass |
| G-26 | MAPPED | tests/substitute_core_quota.test.ts | T-45: substitute-core quota is cumulative across a trading day > CLI: the 2nd substitute-core close exits 1 with the quota message and mutates nothing | 147 | expect(first.exitCode).toBe(0); | 底仓 100 股、申请代冲恰好 100 股（合法不超过当日剩余配额）；断言 exit 0 且余量正确变为 100，配额守卫未误杀额度内的代冲。 | pass |
| G-27 | MAPPED | tests/engine.test.ts | Trader Engine > handles partial close properly | 168 | expect(finalLot.status).toBe(LotStatus.CLOSED); | 对同一批次先平 1000 股、再平剩余 1000 股（合法、未重复平仓）；断言第二次平仓成功且状态为 CLOSED，重复平仓守卫未误杀正常收尾平仓。 | pass |
| G-28 | MAPPED | tests/accounts_reasons.test.ts | Decision thesis: buy / add / close reason persistence > edits an existing lot thesis without touching accounting fields, and can clear it | 379 | expect(updated.cost_basis_unit).toBe(lot.cost_basis_unit); | 合法修改决策理由（`updateLotReason`）；断言理由变更后 `buy_price` / `buy_quantity` / `cost_basis_unit` 逐字段零漂移，只改理由的守卫未误伤会计字段。 | pass |
| G-29 | MAPPED | tests/engine.test.ts | Trader Engine > scene a: deep value alert preserves ACTIVE status strictly | 57 | expect(reloadedLot!.status).toBe(LotStatus.ACTIVE); | 跌幅 -23%（越过深跌线，合法地触发深跌告警而非冻结）；断言批次仍为 `ACTIVE`，深跌守卫未误冻结批次（同用例断言发出 `DEEP_VALUE_ALERT`）。 | pass |
| G-30 | MAPPED | tests/phase2_strategy.test.ts | Phase 2 Core Strategy Logic Tests > dynamic trailing stop: activates at +15% and triggers on 3% pullback from peak | 130 | expect(trailingSig.signal_type).toBe(SignalType.TRAILING_STOP_ALERT); | 浮盈 +18.0%（越过 +15% 激活线）后自峰值 11.80 回撤至 11.40（3.39% > 3% 阈值）；断言确实命中 `TRAILING_STOP_ALERT` 并给出建议动作，条件成立时未漏报。 | pass |
| G-31 | MAPPED | tests/phase2_strategy.test.ts | Phase 2 Core Strategy Logic Tests > dynamic trailing stop: activates at +15% and triggers on 3% pullback from peak | 116 | expect(reloaded.trailing_stop_active).toBe(false); | 浮盈 +12.0%（低于 +15% 激活线，合法地不该激活）；断言 `trailing_stop_active` 保持 false 且只发出普通止盈信号，移动止盈守卫未误触。（低于 3% 回撤的分支无单测，见 §3 部分覆盖披露。） | pass |
| G-32 | MAPPED | tests/engine.test.ts | Trader Engine > scene b: gold etf native T+0 profit take | 77 | expect(sig.suggested_action).toBe("CLOSE_PROFIT"); | 天然 T+0 标的（518880.SH）当日建仓、浮盈 +11.6%；断言按结算机制分流为普通日内止盈（`CLOSE_PROFIT`）并可正常平仓，分流守卫未误判。 | pass |
| G-33 | GAP | — | — | — | — | 原因：`tests/` 无任何 `scan --thresholds` 用例，阈值覆盖生效与 help 示例键可用（SCAN-THR-OVERRIDE / SCAN-MENU-KEYS）都没有单测入口。 ｜ 建议补测：补一条 scan 单测：传入合法阈值覆盖 JSON 后断言由「不报警」翻转为「报警」，并断言 help 里的示例键可被解析。 | — |
| G-34 | GAP | — | — | — | — | 原因：dividend.test.ts:21-45 只登记一笔分红并读回，既没有建批次、也没有读持仓视图或摊薄成本字段，断言落不到 G-34「分红不冲减成本」的判定路径上。 ｜ 建议补测：建仓 → 登记分红 → 断言持仓视图的摊薄成本字段与登记前逐字不变、只有累计现金分红变化。 | — |
| G-35 | MAPPED | tests/serve_dashboard_dual_mode.test.ts | dashboard: zero hardcoded history (P0 anti-regression) > generated HTML is fully ledger-driven and written with mode 0600 | 2661 | expect(statSync(outPath).mode & 0o777).toBe(0o600); | 正常的看板单文件生成（合法产物）；断言产物权限恰为 0600 且无未替换占位符，产物守卫未误伤合法生成。 | pass |
| G-36 | MAPPED | tests/serve_dashboard_dual_mode.test.ts | trade serve: local session credential gate (0600 token) > `trade dashboard` injects the live credential into the generated page | 1795 | expect(withCredential).toContain("window.__LOT_TRADER_SESSION_AUTH_CONFIGURED__ = true;"); | 有凭据与无凭据两种合法生成场景；断言有凭据被注入页面（AUTH_CONFIGURED=true），无凭据时同样能生成并回落独立模式（AUTH_CONFIGURED=false），凭据守卫未误杀任一分支。 | pass |
| G-37 | GAP | — | — | — | — | 原因：`tests/` 只有「模板缺失」的违规侧用例，没有任何「传自定义模板并断言产出自该模板」的合法侧单测。 ｜ 建议补测：补一条 `dashboard --template <自定义模板>` 用例，在自定义模板里塞入唯一标记并断言产物命中该标记。 | — |
| G-38 | MAPPED | tests/accounts_reasons.test.ts | Accounts registry: schema, model & self-healing registration > registers accounts via addAccount and lists them with broker presets | 96 | expect(cmb.account_id).toBe("CMB_BROKERAGE"); | 合法的账户登记（ID 合规、名称非空、券商码与币种合法）；断言登记成功、字段原值写回并可被 `listAccounts` 列出，登记守卫未误杀合法账户。 | pass |
| G-39 | MAPPED | tests/accounts_reasons.test.ts | Accounts registry: schema, model & self-healing registration > SELF-HEALING: buying into an unregistered account auto-inserts a CUSTOM record without interrupting entry | 142 | expect(lot.account_id).toBe("HTSC"); | 向未登记账户 `HTSC` 建仓（合法的自愈场景）；断言买入不被中断、批次账户号正确、账户被自动登记为 `CUSTOM`，自愈守卫未误拦。 | pass |
| G-40 | MAPPED | tests/phase2_strategy.test.ts | Phase 2 Core Strategy Logic Tests > position cap & risk guard: blocks purchases exceeding 30% single-symbol limit | 157 | expect(lot1.lot_id.startsWith("LOT-")).toBe(true); | 组合预算 100,000 元（单测经引擎构造参数注入，等价于环境变量读入后的同一判定路径）下买入 19,800 元（19.80% < 30%）；断言建仓成功，预算换算口径未误杀线下买入。 | pass |
| G-41 | MAPPED | tests/serve_dashboard_dual_mode.test.ts | trade serve: local session credential gate (0600 token) > a failed boot (port already taken) never clobbers the running instance's credential | 1718 | expect((await apiGet(first.srv, "/api/summary")).status).toBe(200); | 抢端口失败的是一个新进程，已在跑的实例属合法运行态；断言其凭据未被覆盖且 `/api/summary` 仍返回 200，端口冲突守卫未误伤持有者。 | pass |
| G-42 | MAPPED | tests/serve_dashboard_dual_mode.test.ts | trade serve: local session credential gate (0600 token) > rotates the token on restart, so a stale file value stops working | 1693 | expect((await apiGet(second, "/api/summary")).status).toBe(200); | 重启后自动生成的新凭据（合法的第 N 次生成）；断言新旧值不同、旧值 401、新值 200 且停机时自动生成文件被删除，凭据轮换未误伤新凭据。 | pass |
| G-43 | MAPPED | tests/serve_dashboard_dual_mode.test.ts | trade serve: port conflict and lifecycle guards > shuts down gracefully on SIGTERM, frees the port and drops the generated credential | 1926 | expect(ready).not.toBeNull(); | `serve --json`（合法输出模式）；断言启动时确实吐出一行可解析的 ready JSON（`code:0` 且带 `data.port`），`--json` 输出契约未被误伤。（`--quiet` 抑制横幅与停机 stopped 行无单测，见 §3 部分覆盖披露。） | pass |
| G-44 | GAP | — | — | — | — | 原因：`tests/` 无任何 `scan --thresholds` 用例，非法 JSON 被拒与非法取值类型被拒的合法对照（合法阈值被接受并生效）都没有单测入口。 ｜ 建议补测：补一条 scan 用例：合法阈值 JSON 被接受并改变告警结果，再补非法 JSON / 非法取值类型各一条断言退出码非零。 | — |
| G-45 | MAPPED | tests/engine.test.ts | Trader Engine > validates lot buy parameters correctly | 29 | expect(lot.status).toBe(LotStatus.ACTIVE); | 合法有限正数价格 6.120 元建仓；断言批次成功创建并保持 ACTIVE，价格守卫未误杀合法价格（同用例前半断言非整手/非正数量被拒）。 | pass |

## 2. 全量单测基线（隔离环境）

命令：`bun test`，cwd 为 `/tmp` 下的仓库副本，`HOME` 与 `LOT_TRADER_DB` / `TRADE_DB_PATH` / `LOT_TRADER_TOKEN_FILE` / `TMPDIR` 全部重定向到沙箱；仓库内不跑 `bun test`。
原始输出：本目录 `bun-test-full.log`（归档运行原文）。

- `tests/*.test.ts` 实际文件数：**18**（`ls tests/*.test.ts | wc -l`；另有 `tests/fixtures/physics_golden_datasets.json` 一个夹具，不计入套件数）
- 归档运行结果：**192 pass / 0 fail / 0 skip**，用例总数 192，18 个文件
- fail 用例清单：**无**

### 2.1 flaky 观测：隔离环境下有两条用例会偶发失败（非本线映射缺陷）

隔离环境下重复运行 checker 时，全量套件出现过**两条**不同的偶发失败。按本目录 `bun-test-nonpass-observations.log`（只追加、不覆盖）统计，统计命令与输出：

```
$ grep -o 'fail: [^|]*' bun-test-nonpass-observations.log | sed 's/^fail: //; s/ *$//' | sort | uniq -c | sort -rn
  14 Physics Engine & Python NumPy Double-Engine Cross-Validation > 3. 动态 Python NumPy 子进程双引擎实时对账 > 动态调用 Python numpy.polyfit 并在位对齐验证
   2 trade dashboard CLI primitive > localizes extra asset-class pillars and keeps every pillar colour distinct (P3-1 / P3-2)
```

该文件共 15 行（`wc -l` = 15，即 15 次非 pass 运行）；除下面两条外没有第三种失败用例。其中 2 行来自 `--leak-parent-env` 对照组：对照组故意让 agent 变量漏给子进程，bun 输出被压成只打失败行，解析出的 `pass=0`，这 2 行里的 numpy 失败也计入上面的 14。

#### flaky #1 — physics numpy 位对齐验证（14 次）

- 用例名：`Physics Engine & Python NumPy Double-Engine Cross-Validation > 3. 动态 Python NumPy 子进程双引擎实时对账 > 动态调用 Python numpy.polyfit 并在位对齐验证`
- 报错首行原文（`bun-test-flaky-sample.log:50`）：`  ^ this test timed out after 5000ms.`；同文件第 49 行失败行带耗时 `[5005.08ms]`
- 归因（实测数字）：`HOME` 重定向进空沙箱后 `uv` 的环境缓存也落在空 HOME 上。该用例第一跳 `uv run --with numpy python3` 在冷 HOME 下需要新建 numpy 环境，实测 **4.230s**；同一 HOME 第二次同命令 **0.115s**。用例内还有第二跳 python 调用与 TS 侧断言，叠加 bun 默认单测超时 5000ms，并发负载下即踩线。
- 原始失败样本：本目录 `bun-test-flaky-sample.log`

#### flaky #2 — dashboard 额外资产类别柱状卡片配色（2 次）

- 用例名：`trade dashboard CLI primitive > localizes extra asset-class pillars and keeps every pillar colour distinct (P3-1 / P3-2)`（`tests/dashboard.test.ts:146` 起，用例自带 60s 超时，不是 5s 默认超时）
- 两次命中的观察行原文：
  1. `2026-10-22T19:07:44.858Z pass=190 fail=2 skip=0 exit=1 | fail: Physics Engine & Python NumPy Double-Engine Cross-Validation > 3. 动态 Python NumPy 子进程双引擎实时对账 > 动态调用 Python numpy.polyfit 并在位对齐验证 || fail: trade dashboard CLI primitive > localizes extra asset-class pillars and keeps every pillar colour distinct (P3-1 / P3-2)`（两个失败同现）
  2. `2026-10-22T19:11:52.470Z pass=191 fail=1 skip=0 exit=1 | fail: trade dashboard CLI primitive > localizes extra asset-class pillars and keeps every pillar colour distinct (P3-1 / P3-2)`（该次它是唯一失败）
- 与运行序号的对位（据本目录 `commands.log`，观察行时间戳紧跟在对应隔离 `bun test` 之后）：第 1 次 = 早先那次 `--inject-missing-test` 运行（`19:07:44.857Z op=bun-test-isolated exit=1` → `19:07:44.974Z check-inject-missing-test exit=1`，该次 `.out` 后来被干净重跑覆盖）；第 2 次 = **当前归档的那次 `--inject-excerpt-mismatch` 运行**（`19:11:52.470Z op=bun-test-isolated exit=1` → `19:11:52.597Z check-inject-excerpt-mismatch exit=1`），所以 `check-inject-excerpt-mismatch.out` 里的 `bun_test_footer=191 pass | 1 fail` 指的就是这条 flaky，而不是注入本身出了问题（该次注入断言 `excerpt_mismatch=1` 正常给出）。
- **报错首行：归档中没有保留，此处不臆测。** 机械原因：checker 每次运行都把原始 stdout+stderr 写进同一个 `bun-test-full.log`，这两次运行的原文随后被下一次运行覆盖；`bun-test-flaky-sample.log` 只在 flaky #1 命中时抓过一份，那份里该用例是 pass。要补上它，只需在下次复现时保留该次原始输出（本线按任务书不改 checker）。
- 可核实的旁证（说明它不是稳定失败）：同一 commit 的归档干净运行里它是绿的——`bun-test-full.log:109` 的 `(pass) trade dashboard CLI primitive > localizes extra asset-class pillars and keeps every pillar colour distinct (P3-1 / P3-2) [1196.96ms]`；门禁线也把这个文件单独隔离跑过一遍且全绿——`docs/qa/evidence/release-gate-20261022-165604-commit-2081243/culprit-dashboard.log`（`5 pass / 0 fail`，该用例 `[1915.92ms]`）。

#### 对本线结论的影响

这两条用例都不在任何 `MAPPED` 行里，checker 的 `not_pass` 只统计被映射的用例，因此 `not_pass` 恒为 0；但 `docs/qa/regression-baseline.md`「`bun test` 100% pass」的表述在隔离环境下不成立，建议后续单独跟踪（本线不改该文档）。

> 口径对账：`docs/qa/release-gate.md` 的「16 个核心测试套件」写于 2026-10-22 13:41，此后 `accounts_reasons.test.ts`、`cli_global_flags.test.ts`、`substitute_core_quota.test.ts` 等新增/拆分，当前实际为 18 个文件；「16」是旧口径，不在本线修改范围内，仅记录差异。

## 3. GAP 清单与补测建议

| G-ID | 类型 | 缺什么 | 建议补的一条单测 |
|---|---|---|---|
| G-01 | 脚手架 | 采集器执行前守卫无产品侧单测入口 | 把守卫抽成可导入函数，补「沙箱 HOME 放行 / 越界 HOME 拒绝」对照用例 |
| G-07 | 纯性质断言 | 401 响应体不含账本字段，无合法侧 | 在 401 用例旁补正向对照：200 响应体确实含 `total_cost` 等字段 |
| G-16 | 边界空白 | 无人测「恰好 30.00% 放行」 | 100,000 元预算下买入恰好 30,000 元并断言不抛错 |
| G-21 | ~~现有合法侧依赖 D-01~~ 已闭合 | 由 `line/tp-458199de-L1` 修复 D-01（冷却改用真实时钟 + 拒绝未来成交时间）后，本行已在 §1 转 `MAPPED`，缺口消失 | 已补：`tests/l1_engine_input_guards.test.ts` 的真实过去时间（-49h）放行用例 + `--time` 为未来值被拒用例（引擎买/加/平三入口 + CLI） |
| G-24 | 整条守卫无单测 | 账户归属不符的平仓拒绝无 CLI 用例 | 补 `--account` 匹配 exit 0 / 不匹配 exit 1 且不落库的 CLI 用例 |
| G-33 | 整条守卫无单测 | `scan --thresholds` 覆盖生效无用例 | 补合法阈值覆盖用例，断言告警结果发生翻转 |
| G-34 | 判定路径未命中 | 分红用例不建批次、不读持仓与摊薄成本 | 建仓 → 登记分红 → 断言摊薄成本字段与登记前逐字不变 |
| G-37 | 只有违规侧 | 自定义模板成功产出无合法侧用例 | 传带唯一标记的自定义模板并断言产物命中该标记 |
| G-44 | 整条守卫无单测 | 阈值参数校验的合法对照无用例 | 补合法阈值 JSON 被接受 + 非法 JSON / 非法取值类型各一条 |

已 `MAPPED` 且**本行引用的用例只覆盖该守卫部分分支**的清单（判定口径允许，但必须披露；括注里写了该分支若已被其它用例覆盖，在哪里）：

| G-ID | 本行已覆盖的分支 | 本行未覆盖的分支 |
|---|---|---|
| G-14 | 健康账本不报降级 | 「空库（schema-only）不误报降级」——由 tests/serve_dashboard_dual_mode.test.ts:931-938 的 `serves an empty ledger without throwing` 覆盖，不在本行引用的用例内 |
| G-17 | `lot add --skip-risk` 放行 | `lot buy --skip-risk`（由 tests/accounts_reasons.test.ts:468、485 覆盖，不在本行）与预算模式下的 `--skip-risk`（BUDGET-SKIP-RISK，全库无单测） |
| G-18 | 组合内只有该标的时同标的连续两次建仓不被拦 | 「累加到很大金额」的规模分支（本行只累到 26,001.30 元）与带显式预算时的同标的累加分支 |
| G-20 | 窗口外放行 + 父链继承 + 层级递增 | 恰好 48h 的边界（`diffMs == cooldownMs` 时 `>=` 与 `<` 的线上行为）；CLI 层 `trade lot add` 的等价路径已由 tests/l1_engine_input_guards.test.ts 的 `CLI POSITIVE CONTROL: a -49h backfilled add is accepted and the row is inserted` 覆盖 |
| G-25 | 账户内有历史底仓时代冲平仓放行 | 同账户但底仓配额不足（tests/substitute_core_quota.test.ts:58 覆盖）、跨账户借用底仓被拒（tests/multi_account.test.ts:64 覆盖）、CLI 层 `--substitute-core` 合法调用（无单测） |
| G-31 | 浮盈低于 +15% 激活线不误触 | 回撤低于 3% 阈值不误报 `TRAILING_STOP_ALERT` |
| G-32 | 天然 T+0 命中止盈 | 法定 T+1 无底仓命中锁定（tests/engine.test.ts:125）、补足底仓后命中日内代冲（tests/engine.test.ts:88）、回调命中加仓（tests/phase2_strategy.test.ts:136）——均在别的用例里，不在本行 |
| G-40 | 预算换算口径下线下买入放行 | `LOT_TRADER_PORTFOLIO_BUDGET` 环境变量从未被任何单测设置（env 读取分支 src/engine.ts:151-152 未覆盖，本行是经构造函数注入）、预算模式下的 `--skip-risk`、恰好 30.00% 边界（同 G-16） |
| G-43 | `--json` 启动一行 ready | `--quiet` 无启动横幅、停机追加一行 stopped |

## 4. 复现方式

```bash
cd /Users/ivywu/Downloads/GitHub/Goodfun-Studio/lot-trader
bun docs/qa/tools/check-guard-unit-map.ts                        # 真实映射，期望全 0
bun docs/qa/tools/check-guard-unit-map.ts --inject-missing-test  # 期望 test_missing=1
bun docs/qa/tools/check-guard-unit-map.ts --inject-excerpt-mismatch  # 期望 excerpt_mismatch=1
bun docs/qa/tools/check-guard-unit-map.ts --leak-parent-env      # 对照组：故意把 agent 环境变量漏给子进程
```

checker 自建并销毁 `/tmp` 沙箱副本；`bun test` 只在副本内执行，绝不在仓库内跑。

### 4.1 子进程环境白名单与 footer 对账

`bun 1.3.14` 在 `CLAUDECODE=1` 或 `REPL_ID=1` 这类 agent 环境下会关掉逐用例输出（只打文件名、失败详情和末尾汇总），不再打印 `(pass) <用例名>` 行。checker 因此：

1. **子进程环境改为白名单构造**：只给 `PATH`（原样继承，保证测试矩阵不打折）+ `HOME` / `TMPDIR` / `LOT_TRADER_DB` / `TRADE_DB_PATH` / `LOT_TRADER_TOKEN_FILE`（全部指向沙箱）。父进程的 `CLAUDECODE` / `CLAUDE_*` / `AI_AGENT` / `AGENT` / `REPL_ID` / `CURSOR*` / `CODEX*` / `ANTHROPIC*` / `OPENAI*` / `MCP*` 一律不传，并在诊断里列出被剥掉的键。
2. **对账断言**：解析出的 `pass` / `fail` / `skip` 数必须等于日志末尾汇总行的同名计数，且三者之和必须等于 `Ran <N> tests`。不相等就计 `parse_mismatch=1`、打一行 `# problem:` 并让 checker 以非 0 退出——绝不允许把「解析不到状态」静默当成 absent。
3. 输出行在原有 8 个字段之后追加 `parse_mismatch=<0|1>`；`--leak-parent-env` 是它自己的对照组：故意把 agent 变量漏给子进程时应当 `parse_mismatch=1` 且退出码非 0。

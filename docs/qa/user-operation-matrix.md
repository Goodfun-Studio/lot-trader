# lot-trader 用户操作矩阵与守卫清单（L1 第 2 轮 · 文档更正版）

> 话题 `tp-5a3bfad8` · 本线 `line-qa-op-matrix`（L1）· 角色 `persona-lot-trader-qa`
>
> 被测对象：仓库 `/Users/ivywu/Downloads/GitHub/Goodfun-Studio/lot-trader`，commit `2081243`
> `./trade` sha256 `3d275c9428a737243cb454dc60d33320a51318220e57c382066b1f50e13462bd`
>
> 证据根目录: `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/`（本轮**未重跑沙箱、未调用 `./trade`**，只重新生成文档）
>
> 操作行的状态由 `harness-r2/build-matrix.py` 从证据重新推导；期望值分别来自 `--help`、规则文档或 §0 的判定规则，每一行都在「期望来源」列标明出处。

## 0. 阅读约定

### 0.1 状态语义

| 状态 | 含义 |
|---|---|
| `PASS` | 实测满足该操作的全部期望（正向成功，或负向被正确拦截且无副作用） |
| `FAIL` | 实测与期望不符 —— 即产品缺陷，逐条登记在 §14 |
| `BLOCKED` | 在本话题约束下无法实测；缺什么能力直接写在该行备注里，汇总见 §14.3 |

状态分布：**PASS 295 · FAIL 11 · BLOCKED 10**（合计 316 行）。

### 0.2 判定规则（§0 分类规则）

同一类「静默吞掉输入」的行为，按后果分成两档，这就是「期望来源 = §0 分类规则」的含义：

| 情形 | 判定 | 例子 |
|---|---|---|
| 静默**污染账本或派生数值** | **FAIL + 缺陷** | 非数值/零/负价入库（D-09）、非法天数把报表清空（D-05）、非法阈值静默关闭止盈（D-07） |
| 静默**回落成合法默认值或返回空集** | **PASS + 观测 V-xx** | 负数金额回落默认基准（V-04）、非法状态枚举返回空列表（V-02）、未知代码返回空集（V-05） |

### 0.3 状态推导命令（核验员可原样复跑）

```
$ python3 docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/harness-r2/build-matrix.py --compare
operation rows in matrix: … / derived: … / status differences: 0
$ python3 docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/harness-r2/build-matrix.py --audit-notes    # 备注声称拦截但实测写库的行数
$ python3 docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/harness-r2/build-matrix.py --audit-guards   # 守卫表空单元格数
```

### 0.4 隔离与取证方法

- 每一次 `trade` 调用都同时满足：显式 `--db /tmp/...`、`HOME=<沙箱>/fakehome`、三个环境变量指向沙箱；采集器对不满足者拒绝执行。
- **`serve` 的 host 并非只有回环别名一种**，本轮实测用到 6 种取值：`127.0.0.1`（13 次）、`0.0.0.0`（1 次）、`192.168.31.44`（1 次）、`'*'`（1 次）、`localhost`（1 次）、`::1`（1 次）。
  其中非回环的 `0.0.0.0` / `192.168.31.44` / `*` 都在**绑定前被拒绝**（exit 非 0、未建立监听），它们与 `--host localhost`、`--host ::1` 都属于 G-04 的门禁用例，不是「只监听回环」的常规会话。
- **不是每个 serve 会话都带 `--token-file`**：4 个会话没带——`SERVE-BIND-ANY0`、`SERVE-BIND-LAN`、`SERVE-BIND-WILD`、`SERVE-DEFAULT-TOKENFILE`。前三个是在绑定阶段就被拒绝的门禁用例（来不及写凭据）；最后一个（`SERVE-DEFAULT-TOKENFILE`）**故意不传**，因为它验证的正是「不传凭据文件参数时产品按默认路径写到哪里」，同时该会话把 `HOME` 指向沙箱并在子进程里 unset 凭据环境变量。
- `--host ::1` 的内核绑定实测为 `[::1]:18599`（原文：`trade   65103 ivywu    7u  IPv6 0x5b11eb77772dd301      0t0  TCP [::1]:18599 (LISTEN)`），公告的 URL 字面量为 `http://::1:18599`——该写法缺少方括号，见观测 V-07。
- `dashboard` 一律显式 `--out` 指向沙箱且不用 `--open`；每个操作都有沙箱 SQLite 逐表行数前后快照，**每个 serve 会话也各有自己的前后快照**。
- 只有两处人为注入沙箱状态，均在 `/tmp` 沙箱库内并单独留证：行情用「读真实现价再反解建仓价」产生（`SCAN-PRIMER-PRICES.txt`），以及无法用 CLI 制造的峰值回撤与降级账本（`SCAN-TRAIL-INJECT.txt`、`SERVE-DEGRADED-WIPE.txt`）。

---

## 全局选项与 help 树

| OP-ID | 命令路径 | `flags` | 写库（实测前后行数差） | `--json` | 期望来源 | 证据 | 状态 | 实测摘要 | 备注 |
|---|---|---|---|:--:|:--:|---|---|---|---|
| `G-HELP` | `trade` | `--db --help` | **0**（各表前后相等） | 否 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/G-HELP.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 根 help 完整列出全部子命令与 `--db` 优先级说明。 |
| `G-HELP-H` | `trade` | `--db` | **0**（各表前后相等） | 否 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/G-HELP-H.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `G-HELP-SHORT-POS` | `trade` | `--db` | **0**（各表前后相等） | 否 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/G-HELP-SHORT-POS.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `G-NO-SUBCMD` | `trade` | `--db` | **0**（各表前后相等） | 否 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/G-NO-SUBCMD.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 不带子命令时打印 help 且退出码为成功，与未知子命令的失败退出码不一致。 |
| `G-VERSION-FLAG` | `trade` | `--db --version` | **0**（各表前后相等） | 否 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/G-VERSION-FLAG.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） | 不存在 `--version`，被当作未知参数并回落 help。 |
| `G-ROOT-JSON` | `trade` | `--db --json` | **0**（各表前后相等） | 否 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/G-ROOT-JSON.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） | 根级不接受 `--json`，回落 help。 |
| `G-UNKNOWN-FLAG` | `trade` | `--db --no-such-global-flag` | **0**（各表前后相等） | 否 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/G-UNKNOWN-FLAG.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） |  |
| `G-UNKNOWN-SUB` | `trade` | `--db` | **0**（各表前后相等） | 否 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/G-UNKNOWN-SUB.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） | 未知子命令：help 输出到 stdout 而非 stderr。 |
| `G-DB-OVER-ENV` | `trade account list` | `--db --json` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/G-DB-OVER-ENV.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 同时给两个环境变量与显式 `--db`，输出只含 `--db` 指向的那个账户，证明 `--db` 覆盖环境变量。 |
| `G-DB-BEFORE-SUBCMD` | `trade` | `--db --json` | 建库 + 初始化 schema | 否 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/G-DB-BEFORE-SUBCMD.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema | `--db` 放在子命令之前同样生效，全局选项位置无关。 |
| `G-DB-BAD-PARENT` | `trade account list` | `--db --json` | 建库 + 初始化 schema | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/G-DB-BAD-PARENT.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema | `--db` 指向不存在的目录时，二进制自动创建父目录并初始化 schema——这正是 checker 必须断言 `--help` 不建库的原因。 |
| `G-ENV-LOTDB-WINS` | `trade` | `--db --json` | — | 否 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/G-ENV-LOTDB-WINS.stdout` | **BLOCKED** | exit `BLOCKED` · Δ — | **BLOCKED — 缺失能力**：需要一次**不带 `--db`** 的调用才能观测环境变量之间的优先级，与本话题隔离规则冲突；建议 L2 在 HOME 与三个环境变量全部重定向到沙箱后单独授权一次。 期望来源：§0 分类规则 |
| `G-ENV-TRADEDB-FALLBACK` | `trade` | `--db --json` | — | 否 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/G-ENV-TRADEDB-FALLBACK.stdout` | **BLOCKED** | exit `BLOCKED` · Δ — | **BLOCKED — 缺失能力**：同上（还需同时不设 `LOT_TRADER_DB`）。 期望来源：§0 分类规则 |
| `G-DEFAULT-DB-PATH` | `trade` | `--db --json` | — | 否 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/G-DEFAULT-DB-PATH.stdout` | **BLOCKED** | exit `BLOCKED` · Δ — | **BLOCKED — 缺失能力**：该级回退会解析到生产账本，本话题明令禁止读写，拒绝执行。 期望来源：§0 分类规则 |
| `CRON-NONE` | `trade` | `—` | — | 否 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/CRON-NONE.stdout` | **BLOCKED** | exit `BLOCKED` · Δ — | **BLOCKED — 缺失能力**：声明性条目：本二进制不存在定时或常驻调度子命令。 期望来源：§0 分类规则 |
| `ZZ-GUARD-SELFTEST-MISSING-DB` | `trade account list` | `--json` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ZZ-GUARD-SELFTEST-MISSING-DB.stdout` | **PASS** | exit `GUARD_VIOLATION` · Δ — | 采集器缺 `--db` 硬守卫的实弹自检：故意提交无 `--db` 的调用，必须在执行前被拒。 |
| `ZZ-GUARD-SELFTEST-BAD-HOME` | `trade account list` | `--db --json` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ZZ-GUARD-SELFTEST-BAD-HOME.stdout` | **PASS** | exit `GUARD_VIOLATION` · Δ — | HOME 守卫的实弹自检：内联 HOME 指向沙箱外时必须被拒。 |
| `ZZ-GUARD-SELFTEST-HOME-CONTROL` | `trade account list` | `--db --json` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ZZ-GUARD-SELFTEST-HOME-CONTROL.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 上一条的对照：同样命令改成沙箱 HOME 后被正常接受并记入日志，证明守卫不误拦。 |
| `HELP-lot` | `trade lot` | `--account --reason --status --close-reason --db --help` | **0**（各表前后相等） | 否 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-lot.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 父级索引 help；子动作的 flag 以散文形式给出。 |
| `HELP-account` | `trade account` | `--all --json --name --broker --currency --account --db --help` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-account.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | `account add` / `account list` 没有独立 help，二者输出与父级逐字节相同。 |
| `HELP-position` | `trade position` | `--symbol --cap --full-position-cap --account --json --db --help` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-position.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `HELP-scan` | `trade scan` | `--thresholds --account --json --db --help` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-scan.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `HELP-stats` | `trade stats` | `--days --symbol --account --json --db --help` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-stats.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `HELP-physics` | `trade physics` | `--symbol --json --db --help` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-physics.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `HELP-dashboard` | `trade dashboard` | `--out --open --template --db --token --token-file --json --help` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-dashboard.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `HELP-serve` | `trade serve` | `--port --host --db --token --token-file --json --quiet --help` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-serve.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `HELP-dividend` | `trade dividend` | `--db --help` | **0**（各表前后相等） | 否 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-dividend.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `HELP-lot-buy` | `trade lot buy` | `--symbol --price --qty --account --reason --fee --time --parent --skip-risk --json --db --help` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-lot-buy.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `HELP-lot-add` | `trade lot add` | `--parent-lot-id --parent --price --amount --qty --account --reason --fee --time --skip-risk --json --db --help` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-lot-add.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `HELP-lot-list` | `trade lot list` | `--status --symbol --account --json --db --help` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-lot-list.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `HELP-lot-close` | `trade lot close` | `--lot-id --price --qty --account --reason --substitute-core --fee --time --json --db --help` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-lot-close.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `HELP-lot-edit` | `trade lot edit` | `--lot-id --reason --buy-reason --close-reason --append --json --db --help` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-lot-edit.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `HELP-account-add` | `trade account add` | `--all --json --name --broker --currency --account --db --help` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-account-add.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 无独立 help，flag 说明由父级散文给出：功能可用但一致性欠缺。 |
| `HELP-account-list` | `trade account list` | `--all --json --name --broker --currency --account --db --help` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-account-list.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `HELP-position-list` | `trade position list` | `--symbol --cap --full-position-cap --account --json --db --help` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-position-list.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | `[list]` 只是可选写法，输出与父级逐字节相同。 |
| `HELP-dividend-add` | `trade dividend add` | `--symbol --amount --date --account --shares --per-share --notes --json --db --help` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-dividend-add.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `HELP-dividend-list` | `trade dividend list` | `--symbol --account --json --db --help` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-dividend-list.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `HELP-radar-alias` | `trade radar` | `--symbol --json --db --help` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-radar-alias.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 输出与 physics 逐字节相同，仅 usage 行标注别名。 |
| `HELP-lot-bogus` | `trade lot` | `--account --reason --status --close-reason --db --help` | **0**（各表前后相等） | 否 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/HELP-lot-bogus.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 未知子动作回落父级 help 且退出码为成功，与根级未知子命令的失败退出码不一致。 |

## 模块一 · 账户 `account`

| OP-ID | 命令路径 | `flags` | 写库（实测前后行数差） | `--json` | 期望来源 | 证据 | 状态 | 实测摘要 | 备注 |
|---|---|---|---|:--:|:--:|---|---|---|---|
| `SEED-ENV-LOTDB` | `trade account add` | `--db --name` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SEED-ENV-LOTDB.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema | 环境变量优先级实验的前置账户。 |
| `SEED-ENV-TRADEDB` | `trade account add` | `--db --name` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SEED-ENV-TRADEDB.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema | 同上。 |
| `SEED-FLAGDB` | `trade account add` | `--db --name` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SEED-FLAGDB.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema | 同上，供 `--db` 覆盖实验使用。 |
| `BUY-SEED-ACC` | `trade account add` | `--broker --db --name` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-SEED-ACC.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema | 主链路前置账户。 |
| `ACC-ADD-ALPHA` | `trade account add` | `--broker --currency --db --name` | `accounts`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ACC-ADD-ALPHA.stdout` | **PASS** | exit `0` · Δ `accounts`+1 |  |
| `ACC-ADD-BETA` | `trade account add` | `--db --name` | `accounts`+1 | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ACC-ADD-BETA.stdout` | **PASS** | exit `0` · Δ `accounts`+1 | 省略券商落 CUSTOM，省略币种落 CNY，默认值生效。 期望来源：§0 分类规则 |
| `ACC-ADD-GAMMA` | `trade account add` | `--broker --currency --db --name` | `accounts`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ACC-ADD-GAMMA.stdout` | **PASS** | exit `0` · Δ `accounts`+1 |  |
| `ACC-ADD-DUP` | `trade account add` | `--broker --db --name` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ACC-ADD-DUP.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 账户登记失败: 账户已存在: ACCA。如需修改请直接更新 accounts 表，避免重复登记。 | 重复 ID 被拦截，失败无副作用。 |
| `ACC-ADD-BADBROKER` | `trade account add` | `--broker --db --name` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ACC-ADD-BADBROKER.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 账户登记失败: 非法券商代码: "NOTABROKER"。可选值: CMB \| CITIC \| HTSC \| EASTMONEY \| GUOTAI \| YINHE \| GF \| PA \| FUTU \| IBKR \| CUSTOM | 非法券商被拦截并列出全部允许值。 |
| `ACC-ADD-NONAME` | `trade account add` | `--db` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ACC-ADD-NONAME.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 账户登记失败: Missing required arguments: <account_id> (or --id), --name |  |
| `ACC-ADD-BADCCY` | `trade account add` | `--currency --db --name` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ACC-ADD-BADCCY.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 账户登记失败: 非法币种: "NOTACURRENCY"。必须为 3 位 ISO 4217 代码，例如 CNY / HKD / USD。 | 非法币种被拦截，要求 ISO 4217 三位码。 |
| `ACC-ADD-JSON` | `trade account add` | `--broker --db --json --name` | `accounts`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ACC-ADD-JSON.stdout` | **PASS** | exit `0` · Δ `accounts`+1 |  |
| `ACC-ADD-LOWERID` | `trade account add` | `--db --name` | `accounts`+1 | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ACC-ADD-LOWERID.stdout` | **PASS** | exit `0` · Δ `accounts`+1 | 小写账户 ID 原样落库，不做归一。 期望来源：§0 分类规则 |
| `ACC-LIST` | `trade account list` | `--db` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ACC-LIST.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `ACC-LIST-ALL` | `trade account list` | `--all --db` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ACC-LIST-ALL.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 当前数据下所有账户都是启用的，`--all` 与默认输出逐字节相同，该分支未被真正覆盖。 |
| `ACC-LIST-JSON` | `trade account list` | `--all --db --json` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ACC-LIST-JSON.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `ACC-LIST-FILTER` | `trade account list` | `--db` | **0**（各表前后相等） | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ACC-LIST-FILTER.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 裸位置参数被静默忽略，仍然输出全部账户。 期望来源：§0 分类规则 |

## 模块二 · 批次买卖 `lot buy` / `list` / `close` / `edit`（含风控、代冲、价格健壮性）

| OP-ID | 命令路径 | `flags` | 写库（实测前后行数差） | `--json` | 期望来源 | 证据 | 状态 | 实测摘要 | 备注 |
|---|---|---|---|:--:|:--:|---|---|---|---|
| `BUY-OK-FLAGS` | `trade lot buy` | `--account --db --fee --price --qty --reason --symbol` | `lots`+1、`trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-OK-FLAGS.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | 全 flag 正向建仓；规费按买入额的比例计收并计入全成本单价。 |
| `BUY-POSITIONAL` | `trade lot buy` | `--account --db` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-POSITIONAL.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | 位置参数简写与 flag 形式等价。 |
| `BUY-JSON` | `trade lot buy` | `--account --db --json --price --qty --symbol` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-JSON.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `BUY-MINIMAL` | `trade lot buy` | `--db --price --qty --symbol` | `lots`+1、`trades`+1 | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-MINIMAL.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | 期望来源：§0 分类规则 |
| `BUY-WITH-TIME` | `trade lot buy` | `--account --db --price --qty --reason --symbol --time` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-WITH-TIME.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | `--time` 生效：批次 ID 的日期前缀取成交日，buy_time 按 UTC 落库。 |
| `BUY-UNKNOWN-ACC` | `trade lot buy` | `--account --db --price --qty --symbol` | `accounts`+1、`lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-UNKNOWN-ACC.stdout` | **PASS** | exit `0` · Δ `accounts`+1、`lots`+1、`trades`+1 | 未知账户被自愈登记后建仓成功。 |
| `BUY-UNKNOWN-SYM` | `trade lot buy` | `--account --db --price --qty --symbol` | `lots`+1、`symbols`+1、`trades`+1 | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-UNKNOWN-SYM.stdout` | **PASS** | exit `0` · Δ `lots`+1、`symbols`+1、`trades`+1 | 未知代码被推断成带市场后缀的代码后建仓成功，并在 symbols 表新增一行。 期望来源：§0 分类规则 |
| `BUY-RISK-WOULD-BLOCK` | `trade lot buy` | `--account --db --price --qty --symbol` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-RISK-WOULD-BLOCK.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 单标的持仓硬顶风控拦截：买入后标的 600519.SH 估算持仓占比为 41.07%，超过 30.00% 组合级硬顶红线 (标的总额 10000.00 / 组合总值 24350.00)！ | 同一组合下不带旁路参数时被硬顶拦截，与下一行的旁路形成对照。 |
| `BUY-SKIP-RISK` | `trade lot buy` | `--account --db --price --qty --skip-risk --symbol` | `lots`+1、`trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-SKIP-RISK.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `NEG-SEED` | `trade account add` | `--db --name` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/NEG-SEED.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `NEG-SEED-LOT` | `trade lot buy` | `--account --db --price --qty --reason --symbol` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/NEG-SEED-LOT.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | 为父批次不匹配用例准备一个真实存在的批次。 |
| `BUY-NEG-QTY` | `trade lot buy` | `--account --db --price --qty --symbol` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-NEG-QTY.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 买入数量必须大于 0 |  |
| `BUY-ZERO-QTY` | `trade lot buy` | `--account --db --price --qty --symbol` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-ZERO-QTY.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 买入数量必须大于 0 |  |
| `BUY-NON-ROUND` | `trade lot buy` | `--account --db --price --qty --symbol` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-NON-ROUND.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 买入数量必须为 100 的整数倍 (一手单位)，当前输入: 150 |  |
| `BUY-MISSING-ARGS` | `trade lot buy` | `--db --symbol` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-MISSING-ARGS.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: Missing required arguments: --symbol, --price, --qty (or: trade lot buy <symbol> <price> <qty>) |  |
| `BUY-NO-ARGS` | `trade lot buy` | `--db` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-NO-ARGS.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: Missing required arguments: --symbol, --price, --qty (or: trade lot buy <symbol> <price> <qty>) |  |
| `BUY-PRICE-ZERO` | `trade lot buy` | `--account --db --price --qty --symbol` | `lots`+1、`trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-PRICE-ZERO.stdout` | **FAIL** | exit `0` · Δ `lots`+1、`trades`+1 | **未拦截、已写库**：零价被接受并写入账本（成交单价 0.0000、规费 0.00），归入缺陷 D-09。第 1 轮曾把这一行误记为**已拦截**——那一轮它与大量批次共库，被 30% 仓位硬顶挡下，退出码掩盖了价格校验的缺失。 ｜ 推导差异: exit 0 == 0 but the run expected a refusal; a user-data table grew (no write was expected); delta lots=1 != 0 |
| `BUY-PRICE-NEG` | `trade lot buy` | `--account --db --price --qty --symbol` | `lots`+1、`trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-PRICE-NEG.stdout` | **FAIL** | exit `0` · Δ `lots`+1、`trades`+1 | **未拦截、已写库**：负价被接受并写入账本（成交单价 -2.5000、全成本单价 -2.5005、规费 -0.05，规费也成了负数），归入缺陷 D-09。第 1 轮对这一行的判断同为零价那条所述的假通过。 ｜ 推导差异: exit 0 == 0 but the run expected a refusal; a user-data table grew (no write was expected); delta lots=1 != 0 |
| `BUY-PRICE-NAN` | `trade lot buy` | `--account --db --price --qty --reason --symbol` | `lots`+1、`trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-PRICE-NAN.stdout` | **FAIL** | exit `0` · Δ `lots`+1、`trades`+1 | **非数值价格被产品接受**：详见缺陷 D-09。 ｜ 推导差异: exit 0 == 0 but the run expected a refusal; a user-data table grew (no write was expected); delta lots=1 != 0; delta trades=1 != 0 |
| `BUY-PARENT-MISS` | `trade lot buy` | `--account --db --parent --price --qty --symbol` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-PARENT-MISS.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 指定的父批次不存在: LOT-19990101-999 |  |
| `BUY-PARENT-MISM` | `trade lot buy` | `--account --db --parent --price --qty --skip-risk --symbol` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUY-PARENT-MISM.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 父批次标的 (518880.SH) 与当前买入标的 (600519.SH) 不一致 |  |
| `RISK-SEED-OTHER` | `trade lot buy` | `--account --db --price --qty --symbol` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/RISK-SEED-OTHER.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `RISK-PASS-UNDER` | `trade lot buy` | `--account --db --price --qty --symbol` | `lots`+1、`trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/RISK-PASS-UNDER.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | 占比低于硬顶线时放行。 |
| `RISK-BLOCK-OVER` | `trade lot buy` | `--account --db --price --qty --symbol` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/RISK-BLOCK-OVER.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 单标的持仓硬顶风控拦截：买入后标的 159937.SZ 估算持仓占比为 33.33%，超过 30.00% 组合级硬顶红线 (标的总额 1400.00 / 组合总值 4200.00)！ | 占比越过硬顶线时拦截，且批次数不变。 |
| `RISK-BLOCK-XL` | `trade lot buy` | `--account --db --price --qty --symbol` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/RISK-BLOCK-XL.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 单标的持仓硬顶风控拦截：买入后标的 600519.SH 估算持仓占比为 97.92%，超过 30.00% 组合级硬顶红线 (标的总额 131849.00 / 组合总值 134649.00)！ | 同一 DB 上换成大额买入同样被拦截，风控在任何量级都生效。 |
| `RISK-SKIP-RISK` | `trade lot buy` | `--account --db --price --qty --skip-risk --symbol` | `lots`+1、`trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/RISK-SKIP-RISK.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `RISK-READBACK` | `trade position` | `--db --json` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/RISK-READBACK.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `RKE-SEED-OTHER` | `trade lot buy` | `--account --db --price --qty --symbol` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/RKE-SEED-OTHER.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `RKE-EXACT-30PCT` | `trade lot buy` | `--account --db --price --qty --symbol` | `lots`+1、`trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/RKE-EXACT-30PCT.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | 占比恰好落在硬顶线上时放行，说明守卫用的是严格大于。 |
| `RKO-SEED-OTHER` | `trade lot buy` | `--account --db --price --qty --symbol` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/RKO-SEED-OTHER.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `RKO-OVER-30PCT` | `trade lot buy` | `--account --db --price --qty --symbol` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/RKO-OVER-30PCT.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 单标的持仓硬顶风控拦截：买入后标的 159915.SZ 估算持仓占比为 30.00%，超过 30.00% 组合级硬顶红线 (标的总额 3000.50 / 组合总值 10000.50)！ | 占比刚刚越过硬顶线时拦截；错误文案把比例四舍五入后与阈值并列，属可读性瑕疵（见 D-06）。 |
| `RISKSAME-SEED` | `trade lot buy` | `--account --db --price --qty --symbol` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/RISKSAME-SEED.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `RISKSAME-HUGE` | `trade lot buy` | `--account --db --price --qty --symbol` | `lots`+1、`trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/RISKSAME-HUGE.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | 同一标的内累加到很大金额仍不触发该硬顶，说明它是跨标的的组合窗口口径。 |
| `RISKSAME-READBACK` | `trade position` | `--db --json` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/RISKSAME-READBACK.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `BUDGET-PASS-EXACT` | `trade lot buy` | `--account --db --price --qty --symbol` | 建库 + 初始化 schema | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUDGET-PASS-EXACT.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `BUDGET-BLOCK-OVER` | `trade lot buy` | `--account --db --price --qty --symbol` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUDGET-BLOCK-OVER.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 单标的持仓硬顶风控拦截：买入后标的 600519.SH 估算持仓占比为 31.00%，超过 30.00% 组合级硬顶红线 (标的总额 3100.00 / 组合总值 10000.00)！ |  |
| `BUDGET-BLOCK-XL` | `trade lot buy` | `--account --db --price --qty --symbol` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUDGET-BLOCK-XL.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 单标的持仓硬顶风控拦截：买入后标的 000001.SZ 估算持仓占比为 75.00%，超过 30.00% 组合级硬顶红线 (标的总额 9000.00 / 组合总值 12000.00)！ |  |
| `BUDGET-SKIP-RISK` | `trade lot buy` | `--account --db --price --qty --skip-risk --symbol` | `lots`+1、`trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/BUDGET-SKIP-RISK.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `PG-SEED` | `trade account add` | `--db --name` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/PG-SEED.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema | 价格守卫实验的前置账户。 |
| `PRICE-GUARD-ILLEGAL` | `trade lot buy` | `--account --db --price --qty --reason --symbol` | `lots`+1、`trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/PRICE-GUARD-ILLEGAL.stdout` | **FAIL** | exit `0` · Δ `lots`+1、`trades`+1 | **价格守卫的违规侧失败**：非数值价格未被拦截，详见缺陷 D-09。 ｜ 推导差异: exit 0 == 0 but the run expected a refusal; a user-data table grew (no write was expected); delta lots=1 != 0; delta trades=1 != 0 |
| `PRICE-GUARD-LEGAL` | `trade lot buy` | `--account --db --price --qty --reason --symbol` | `lots`+1、`trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/PRICE-GUARD-LEGAL.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | 价格守卫的合法侧：正常价格建仓成功且正常写库，守卫不误杀合法调用。 |
| `NAN-SEED` | `trade account add` | `--db --name` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/NAN-SEED.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema | NaN 缺陷实验的前置账户。 |
| `NAN-POLLUTION-POS` | `trade position` | `--db --json` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/NAN-POLLUTION-POS.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 读取被污染的组合视图：金额字段被序列化成空值。 |
| `NAN-POLLUTION-LIST` | `trade lot list` | `--db --json --status` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/NAN-POLLUTION-LIST.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 读取被污染的批次列表：价格字段被序列化成空值。 |
| `NAN-POLLUTION-STATS` | `trade stats` | `--db` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/NAN-POLLUTION-STATS.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 在同一被污染库上读取战绩报表。 |
| `NAN-POLLUTION-SCAN` | `trade scan` | `--db --json` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/NAN-POLLUTION-SCAN.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 在同一被污染库上跑信号扫描。 |
| `LIST-DEFAULT` | `trade lot list` | `--db` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/LIST-DEFAULT.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `LIST-STATUS-ACTIVE` | `trade lot list` | `--db --status` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/LIST-STATUS-ACTIVE.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `LIST-STATUS-CLOSED` | `trade lot list` | `--db --status` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/LIST-STATUS-CLOSED.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `LIST-STATUS-ALL` | `trade lot list` | `--db --status` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/LIST-STATUS-ALL.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `LIST-STATUS-BAD` | `trade lot list` | `--db --status` | **0**（各表前后相等） | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/LIST-STATUS-BAD.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 非法状态枚举被静默当成匹配不到，而非报错。 期望来源：§0 分类规则 |
| `LIST-STATUS-LOWER` | `trade lot list` | `--db --status` | **0**（各表前后相等） | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/LIST-STATUS-LOWER.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 小写状态同样静默返回空列表。 期望来源：§0 分类规则 |
| `LIST-SYMBOL` | `trade lot list` | `--db --symbol` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/LIST-SYMBOL.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `LIST-ACCOUNT` | `trade lot list` | `--account --db` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/LIST-ACCOUNT.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `LIST-JSON` | `trade lot list` | `--db --json --status` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/LIST-JSON.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `LIST-EMPTY-DB` | `trade lot list` | `--db` | 建库 + 初始化 schema | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/LIST-EMPTY-DB.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema | 空库也能优雅返回。 期望来源：§0 分类规则 |
| `LIST-POSITIONAL` | `trade lot list` | `--db` | **0**（各表前后相等） | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/LIST-POSITIONAL.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 裸位置参数被静默忽略。 期望来源：§0 分类规则 |
| `LIST-AFTER-CLOSE` | `trade lot list` | `--db --json --status` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/LIST-AFTER-CLOSE.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `CLOSE-PARTIAL` | `trade lot close` | `--account --db --lot-id --price --qty --reason` | `trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/CLOSE-PARTIAL.stdout` | **PASS** | exit `0` · Δ `trades`+1 | 部分平仓后批次保持活跃，并写入一条成交流水。 |
| `CLOSE-QTY-OVER` | `trade lot close` | `--db --lot-id --price --qty` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/CLOSE-QTY-OVER.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 平仓失败: 平仓数量 99999 超过剩余可用数量 4600 |  |
| `CLOSE-ACCT-MISM` | `trade lot close` | `--account --db --lot-id --price` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/CLOSE-ACCT-MISM.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 平仓失败: 批次账户不匹配：批次 LOT-20261022-001 属于账户 ACCA，而非指定的 ACCB |  |
| `CLOSE-LOT-MISSING` | `trade lot close` | `--db --lot-id --price` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/CLOSE-LOT-MISSING.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 平仓失败: 批次不存在: LOT-19990101-999 |  |
| `CLOSE-MISSING-ARG` | `trade lot close` | `--db --lot-id` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/CLOSE-MISSING-ARG.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 平仓失败: Missing required arguments: --lot-id, --price (or: trade lot close <lot_id> <price> [qty]) |  |
| `CLOSE-POSITIONAL` | `trade lot close` | `--db --reason` | `trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/CLOSE-POSITIONAL.stdout` | **PASS** | exit `0` · Δ `trades`+1 | 位置参数简写对天然 T+0 标的全额平仓成功。 |
| `CLOSE-JSON` | `trade lot close` | `--db --json --lot-id --price --qty` | `trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/CLOSE-JSON.stdout` | **PASS** | exit `0` · Δ `trades`+1 |  |
| `CLOSE-T1-LOCKED` | `trade lot close` | `--db --lot-id --price` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/CLOSE-T1-LOCKED.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 平仓失败: 标的 510300.SH 为法定 T+1，当日买入份额无法直接平仓。若有可用底仓请指定 --substitute-core | 法定 T+1 当日买入且账户内无底仓时被拦截，并提示可用的代冲参数。 |
| `CLOSE-SEED-CORE` | `trade lot buy` | `--account --db --price --qty --reason --skip-risk --symbol --time` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/CLOSE-SEED-CORE.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | 为同一账户补一笔昨日之前的底仓，作为代冲配额来源。 |
| `CLOSE-T1-TODAY` | `trade lot buy` | `--account --db --price --qty --reason --skip-risk --symbol` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/CLOSE-T1-TODAY.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | 当日再买入同标的，作为代冲卖出对象。 |
| `CLOSE-SUBCORE-T1` | `trade lot close` | `--account --db --lot-id --price --qty --reason --substitute-core` | `trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/CLOSE-SUBCORE-T1.stdout` | **PASS** | exit `0` · Δ `trades`+1 | 底仓充足时代冲放行并全额平仓。 |
| `CLOSE-SUBCORE-NAT` | `trade lot close` | `--account --db --lot-id --price --qty --substitute-core` | `trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/CLOSE-SUBCORE-NAT.stdout` | **PASS** | exit `0` · Δ `trades`+1 | 天然 T+0 标的带代冲参数也成功，输出提示为天然回转。 |
| `CLOSE-FULL` | `trade lot close` | `--db --lot-id --price --reason` | `trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/CLOSE-FULL.stdout` | **PASS** | exit `0` · Δ `trades`+1 |  |
| `CLOSE-TWICE` | `trade lot close` | `--db --lot-id --price` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/CLOSE-TWICE.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 平仓失败: 批次 LOT-20261022-001 已经是 CLOSED 状态，不可重复平仓 | 对已平仓批次再次平仓被拦截。 |
| `CLOSE-ACCT-SEED` | `trade account add` | `--db --name` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/CLOSE-ACCT-SEED.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `CLOSE-ACCT-LOT` | `trade lot buy` | `--account --db --price --qty --symbol` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/CLOSE-ACCT-LOT.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `CLOSE-ACCT-OK` | `trade lot close` | `--account --db --lot-id --price --qty` | `trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/CLOSE-ACCT-OK.stdout` | **PASS** | exit `0` · Δ `trades`+1 | 该账户自己的批次正常平仓，作为账户归属守卫的合法侧。 |
| `XACC-SEED-A` | `trade account add` | `--db --name` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/XACC-SEED-A.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `XACC-SEED-B` | `trade account add` | `--db --name` | `accounts`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/XACC-SEED-B.stdout` | **PASS** | exit `0` · Δ `accounts`+1 |  |
| `XACC-CORE-A` | `trade lot buy` | `--account --db --price --qty --reason --skip-risk --symbol --time` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/XACC-CORE-A.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | 账户 A 建立昨日之前的同标的底仓。 |
| `XACC-TODAY-B` | `trade lot buy` | `--account --db --price --qty --reason --skip-risk --symbol` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/XACC-TODAY-B.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | 账户 B 当日买入同标的。 |
| `XACC-POS` | `trade position` | `--db --json --symbol` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/XACC-POS.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `XACC-SUBCORE-BLOCK` | `trade lot close` | `--account --db --lot-id --price --qty --reason --substitute-core` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/XACC-SUBCORE-BLOCK.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 平仓失败: 底仓可用配额不足，严防裸卖空！账户 XB 标的 510300.SH 总底仓 0 股，今日已代冲 0 股，剩余可用配额仅 0 股，申请代冲 200 股 | 跨账户代冲被拦截：B 看不到 A 的底仓，账户维度的可用配额独立计算。 |
| `XACC-SUBCORE-NOFLAG` | `trade lot close` | `--account --db --lot-id --price --qty` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/XACC-SUBCORE-NOFLAG.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 平仓失败: 标的 510300.SH 为法定 T+1，当日买入份额无法直接平仓。若有可用底仓请指定 --substitute-core |  |
| `XACC-SCAN` | `trade scan` | `--db --json` | `signals`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/XACC-SCAN.stdout` | **PASS** | exit `0` · Δ `signals`+1 | 扫描侧同口径：A 的历史批次命中止盈，B 的当日批次因账户内底仓为零命中 T+1 锁定。 |
| `XACC-CORE-SAME-ACCT` | `trade lot buy` | `--account --db --price --qty --reason --skip-risk --symbol --time` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/XACC-CORE-SAME-ACCT.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `XACC-SUBCORE-ALLOW` | `trade lot close` | `--account --db --lot-id --price --qty --reason --substitute-core` | `trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/XACC-SUBCORE-ALLOW.stdout` | **PASS** | exit `0` · Δ `trades`+1 | 给 B 补上自己的底仓后放行，与拦截行构成成对断言。 |
| `EDIT-TARGET-INFO` | `trade lot list` | `--db --json --status --symbol` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/EDIT-TARGET-INFO.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `EDIT-REASON` | `trade lot edit` | `--db --lot-id --reason` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/EDIT-REASON.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 覆盖买入理由。 |
| `EDIT-BUY-REASON` | `trade lot edit` | `--buy-reason --db --lot-id` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/EDIT-BUY-REASON.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `EDIT-CLOSE-REASON` | `trade lot edit` | `--close-reason --db --lot-id` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/EDIT-CLOSE-REASON.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `EDIT-APPEND` | `trade lot edit` | `--append --db --lot-id --reason` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/EDIT-APPEND.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 追加而非覆盖。 |
| `EDIT-POSITIONAL` | `trade lot edit` | `--db --reason` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/EDIT-POSITIONAL.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `EDIT-JSON` | `trade lot edit` | `--db --json --lot-id --reason` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/EDIT-JSON.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | `--json` 形式。 |
| `EDIT-NOTFOUND` | `trade lot edit` | `--db --lot-id --reason` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/EDIT-NOTFOUND.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 更新理由失败: 批次不存在: LOT-19990101-999 |  |
| `EDIT-NO-FLAG` | `trade lot edit` | `--db --lot-id` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/EDIT-NO-FLAG.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 更新理由失败: Missing reason: pass --reason <TEXT> (buy thesis) and/or --close-reason <TEXT> | 既不给买入理由也不给平仓理由时被拦截。 |

> **会计字段零漂移证据**：对同一批次的会计与状态列做前后快照比对，差异只出现在理由列。 证据：`EDIT-ACCT-SAFETY.before.txt` / `.after.txt` / `.diff.txt`。

## 模块三 · 加仓防抖 `lot add`

| OP-ID | 命令路径 | `flags` | 写库（实测前后行数差） | `--json` | 期望来源 | 证据 | 状态 | 实测摘要 | 备注 |
|---|---|---|---|:--:|:--:|---|---|---|---|
| `ADD-SEED-PARENT` | `trade lot buy` | `--account --db --price --qty --reason --symbol --time` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-SEED-PARENT.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema | 父批次回填到冷却窗口之外，用于构造「冷却期外」场景。 |
| `ADD-AMOUNT-DEFAULT` | `trade lot add` | `--account --db --parent-lot-id --price --reason --skip-risk` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-AMOUNT-DEFAULT.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | 只给价格时按默认金额基准折算股数，并生成子层级。 |
| `ADD-COOLDOWN-BLOCK` | `trade lot add` | `--account --db --parent-lot-id --price --reason --skip-risk` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-COOLDOWN-BLOCK.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 加仓失败: 加仓防抖冷却窗口守卫拦截：同源血缘链批次 LOT-20261022-001 (L1) 于 2026-10-22T14:21:28.028Z 已执行加仓，尚在 48 小时 (2 个交易日) 防抖冷却窗口内 (剩余 48.0 小 | **同源防抖拦截**：父批次短时间内二次加仓被拒，批次数不变。 |
| `ADD-TIME-FORGERY` | `trade lot add` | `--account --db --parent-lot-id --price --reason --skip-risk --time` | `lots`+1、`trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-TIME-FORGERY.stdout` | **FAIL** | exit `0` · Δ `lots`+1、`trades`+1 | **守卫可被绕过**：把加仓的成交时间写成未来值后，同一血缘链在真实时间轴上只隔了几分钟却放行，详见缺陷 D-01。 ｜ 推导差异: exit 0 == 0 but the run expected a refusal; a user-data table grew (no write was expected); delta lots=1 != 0; missing text /防抖/ |
| `ADD-SEED-PARENT2` | `trade lot buy` | `--account --db --price --qty --reason --symbol --time` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-SEED-PARENT2.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `ADD-P2-L1` | `trade lot add` | `--account --db --parent-lot-id --price --reason --skip-risk --time` | `lots`+1、`trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-P2-L1.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | 在另一条血缘链里造一个冷却窗口之外的子批次。 |
| `ADD-AFTER-48H` | `trade lot add` | `--account --db --parent-lot-id --price --reason --skip-risk` | `lots`+1、`trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-AFTER-48H.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | 冷却期外放行且层级递增，与拦截行构成成对断言。 |
| `ADD-AFTER-48H-POS` | `trade position` | `--db --json` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-AFTER-48H-POS.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `ADD-FORGED-INVISIBLE` | `trade lot add` | `--account --db --parent-lot-id --price --reason --skip-risk --time` | `lots`+1、`trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-FORGED-INVISIBLE.stdout` | **FAIL** | exit `0` · Δ `lots`+1、`trades`+1 | 把成交时间伪造得更远同样放行，进一步印证 D-01。 ｜ 推导差异: exit 0 == 0 but the run expected a refusal; a user-data table grew (no write was expected); delta lots=1 != 0; missing text /防抖/ |
| `ADD-SEED-P3` | `trade lot buy` | `--account --db --price --qty --skip-risk --symbol --time` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-SEED-P3.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `ADD-SEED-P4` | `trade lot buy` | `--account --db --price --qty --skip-risk --symbol --time` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-SEED-P4.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `ADD-SEED-P5` | `trade lot buy` | `--account --db --price --qty --skip-risk --symbol --time` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-SEED-P5.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `ADD-SEED-P6` | `trade lot buy` | `--account --db --price --qty --skip-risk --symbol --time` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-SEED-P6.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `ADD-SEED-P7` | `trade lot buy` | `--account --db --price --qty --skip-risk --symbol --time` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-SEED-P7.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `ADD-SEED-P8` | `trade lot buy` | `--account --db --price --qty --skip-risk --symbol --time` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-SEED-P8.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `ADD-SEED-P9` | `trade lot buy` | `--account --db --price --qty --skip-risk --symbol --time` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-SEED-P9.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `ADD-QTY-EXPLICIT` | `trade lot add` | `--account --db --parent-lot-id --price --qty --skip-risk` | `lots`+1、`trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-QTY-EXPLICIT.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `ADD-POSITIONAL` | `trade lot add` | `--account --db --skip-risk` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-POSITIONAL.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `ADD-JSON` | `trade lot add` | `--account --db --json --parent-lot-id --price --skip-risk` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-JSON.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `ADD-ACCOUNT-OVERR` | `trade lot add` | `--account --db --parent-lot-id --price --skip-risk` | `accounts`+1、`lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-ACCOUNT-OVERR.stdout` | **PASS** | exit `0` · Δ `accounts`+1、`lots`+1、`trades`+1 |  |
| `ADD-AMOUNT-TINY` | `trade lot add` | `--account --amount --db --parent-lot-id --price --skip-risk` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-AMOUNT-TINY.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | 金额小于一手时兜底为最小一手，不报错。 |
| `ADD-AMOUNT-ZERO` | `trade lot add` | `--account --amount --db --parent-lot-id --price --skip-risk` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-AMOUNT-ZERO.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | 零金额回落到默认金额基准折算。 |
| `ADD-AMOUNT-NEG` | `trade lot add` | `--account --amount --db --parent-lot-id --price --skip-risk` | `lots`+1、`trades`+1 | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-AMOUNT-NEG.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 | **负数金额不报错**，同样回落默认基准，见观测 V-04。 期望来源：§0 分类规则 |
| `ADD-NON-ROUND-QTY` | `trade lot add` | `--account --db --parent-lot-id --price --qty --skip-risk` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-NON-ROUND-QTY.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 加仓失败: 买入数量必须为 100 的整数倍 (一手单位)，当前输入: 150 | 非整百股数被拦截。 |
| `ADD-PARENT-MISS` | `trade lot add` | `--db --parent-lot-id --price` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-PARENT-MISS.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 加仓失败: 指定的父批次不存在: LOT-19990101-999 |  |
| `ADD-MISSING-ARGS` | `trade lot add` | `--db --price` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/ADD-MISSING-ARGS.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 加仓失败: Missing required arguments: --parent-lot-id (or --parent), --price (or: trade lot add <lot_id> <price>) |  |

## 模块四 · 持仓聚合 `position`

| OP-ID | 命令路径 | `flags` | 写库（实测前后行数差） | `--json` | 期望来源 | 证据 | 状态 | 实测摘要 | 备注 |
|---|---|---|---|:--:|:--:|---|---|---|---|
| `POS-DEFAULT` | `trade position` | `--db` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/POS-DEFAULT.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 三层视图：组合总览、标的汇总、批次明细。 |
| `POS-JSON` | `trade position` | `--db --json` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/POS-JSON.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `POS-SYMBOL` | `trade position` | `--db --symbol` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/POS-SYMBOL.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `POS-CAP` | `trade position` | `--cap --db --json` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/POS-CAP.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | `--cap` 生效，满仓额度按传入值显示。 |
| `POS-FULLCAP-ALIAS` | `trade position` | `--db --full-position-cap --json` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/POS-FULLCAP-ALIAS.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | `--full-position-cap` 与 `--cap` 等价。 |
| `POS-ACCOUNT` | `trade position` | `--account --db` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/POS-ACCOUNT.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `POS-LIST-ALIAS` | `trade position list` | `--db` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/POS-LIST-ALIAS.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `POS-EMPTY-DB` | `trade position` | `--db` | **0**（各表前后相等） | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/POS-EMPTY-DB.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 空库输出提示文案而非报错。 期望来源：§0 分类规则 |
| `POS-BAD-SYMBOL` | `trade position` | `--db --symbol` | **0**（各表前后相等） | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/POS-BAD-SYMBOL.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 不存在的标的返回空集而非报错。 期望来源：§0 分类规则 |
| `POS-NAN-CLEAN-CHECK` | `trade position` | `--db --json` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/POS-NAN-CLEAN-CHECK.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 主链路库上重复做一次组合视图，用于证明 NaN 缺陷被限制在独立库内。 |

## 模块五 · 信号扫描 `scan`

| OP-ID | 命令路径 | `flags` | 写库（实测前后行数差） | `--json` | 期望来源 | 证据 | 状态 | 实测摘要 | 备注 |
|---|---|---|---|:--:|:--:|---|---|---|---|
| `SCAN-PRIMER-BUY1` | `trade lot buy` | `--account --db --price --qty --skip-risk --symbol` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-PRIMER-BUY1.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `SCAN-PRIMER-BUY2` | `trade lot buy` | `--account --db --price --qty --skip-risk --symbol` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-PRIMER-BUY2.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `SCAN-PRIMER-LIST` | `trade lot list` | `--db --json --status` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-PRIMER-LIST.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | **行情注入方法**：本线不伪造行情源，而是先读真实现价、再反解建仓价，让收益率落在被测区间。 |
| `SCAN-TP-BUY` | `trade lot buy` | `--account --db --price --qty --reason --symbol` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-TP-BUY.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `SCAN-TP-RUN` | `trade scan` | `--db --json` | `signals`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-TP-RUN.stdout` | **PASS** | exit `0` · Δ `signals`+1 | 天然 T+0 标的浮盈越线命中止盈信号。 |
| `SCAN-T1LOCK-BUY` | `trade lot buy` | `--account --db --price --qty --reason --symbol` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-T1LOCK-BUY.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `SCAN-T1LOCK-RUN` | `trade scan` | `--db --json` | `signals`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-T1LOCK-RUN.stdout` | **PASS** | exit `0` · Δ `signals`+1 | 法定 T+1 当日买入且账户内底仓为零时命中 T+1 锁定信号。 |
| `SCAN-DT-CORE` | `trade lot buy` | `--account --db --price --qty --reason --symbol --time` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-DT-CORE.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `SCAN-DT-TODAY` | `trade lot buy` | `--account --db --price --qty --reason --symbol` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-DT-TODAY.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `SCAN-DT-RUN` | `trade scan` | `--db --json` | `signals`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-DT-RUN.stdout` | **PASS** | exit `0` · Δ `signals`+1 | 补足底仓后同一当日批次改为命中日内代冲止盈信号；两条信号并存。 |
| `SCAN-ADD-BUY` | `trade lot buy` | `--account --db --price --qty --reason --symbol` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-ADD-BUY.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `SCAN-ADD-RUN` | `trade scan` | `--db --json` | `signals`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-ADD-RUN.stdout` | **PASS** | exit `0` · Δ `signals`+1 | 回调到加仓区间时命中梯级加仓信号，附带建议基准金额与下一层级。 |
| `SCAN-DEEP-BUY` | `trade lot buy` | `--account --db --price --qty --reason --symbol` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-DEEP-BUY.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `SCAN-DEEP-RUN` | `trade scan` | `--db --json` | `signals`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-DEEP-RUN.stdout` | **PASS** | exit `0` · Δ `signals`+1 | 深跌区间命中深跌信号，payload 显式声明状态保持活跃且未冻结。 |
| `SCAN-DEEP-CLOSE` | `trade lot close` | `--db --lot-id --price --qty --reason` | `trades`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-DEEP-CLOSE.stdout` | **PASS** | exit `0` · Δ `trades`+1 | 深跌批次仍可正常平仓，证明「禁止冻结」不只是标记。 |
| `SCAN-DEEP-AFTER` | `trade lot list` | `--db --json --status` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-DEEP-AFTER.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `SCAN-TRAIL-BUY` | `trade lot buy` | `--account --db --price --qty --reason --symbol` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-TRAIL-BUY.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `SCAN-TRAIL-RUN` | `trade scan` | `--db --json` | `signals`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-TRAIL-RUN.stdout` | **PASS** | exit `0` · Δ `signals`+1 | 峰值回撤越过阈值时命中移动止盈信号，payload 给出峰值、回撤比例与建议股数。 |
| `SCAN-TRAIL-BELOW` | `trade scan` | `--db --json` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-TRAIL-BELOW.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | **移动止盈的负向防误杀**：把峰值抬到刚好使回撤低于阈值后，告警计数为零。 |
| `SCAN-THR-BUY` | `trade lot buy` | `--account --db --price --qty --reason --symbol` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-THR-BUY.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `SCAN-THR-DEFAULT` | `trade scan` | `--db --json` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-THR-DEFAULT.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 默认阈值下收益率未达止盈线，不产生任何信号。 |
| `SCAN-THR-OVERRIDE` | `trade scan` | `--db --json --thresholds` | `signals`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-THR-OVERRIDE.stdout` | **PASS** | exit `0` · Δ `signals`+1 | 用实现真正读取的阈值键降低止盈线后，同批次立刻命中。 |
| `SCAN-MENU-KEYS` | `trade scan` | `--db --json --thresholds` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-MENU-KEYS.stdout` | **FAIL** | exit `0` · Δ **0**（各表前后相等） | **缺陷 D-02**：直接照抄 help 给出的阈值示例后，仍然没有任何信号。 ｜ 推导差异: missing text /_ALERT/ |
| `SCAN-BAD-JSON` | `trade scan` | `--db --thresholds` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-BAD-JSON.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 扫描信号失败: JSON Parse error: Unexpected identifier "not" | 非法 JSON 被拒绝并给出解析错误。 |
| `SCAN-BAD-THRESHOLD` | `trade scan` | `--db --json --thresholds` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-BAD-THRESHOLD.stdout` | **FAIL** | exit `0` · Δ **0**（各表前后相等） | **缺陷 D-07**：阈值写成字符串时既不报错也不校验，静默失去止盈告警。 ｜ 推导差异: exit 0 == 0 but the run expected a refusal |
| `SCAN-EMPTY-DB` | `trade scan` | `--db --json` | **0**（各表前后相等） | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-EMPTY-DB.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 期望来源：§0 分类规则 |
| `SCAN-ACCOUNT-FILT` | `trade scan` | `--account --db --json` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-ACCOUNT-FILT.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `SCAN-ACCOUNT-NONE` | `trade scan` | `--account --db --json` | **0**（各表前后相等） | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SCAN-ACCOUNT-NONE.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 期望来源：§0 分类规则 |

## 模块六 · 战绩归因 `stats`

| OP-ID | 命令路径 | `flags` | 写库（实测前后行数差） | `--json` | 期望来源 | 证据 | 状态 | 实测摘要 | 备注 |
|---|---|---|---|:--:|:--:|---|---|---|---|
| `STATS-DEFAULT` | `trade stats` | `--db` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/STATS-DEFAULT.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 多维归因报表：平仓笔数、胜率、累计净利、盈亏比与按类型/标的拆分。 |
| `STATS-JSON` | `trade stats` | `--db --json` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/STATS-JSON.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `STATS-DAYS` | `trade stats` | `--days --db --json` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/STATS-DAYS.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `STATS-SYMBOL` | `trade stats` | `--db --json --symbol` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/STATS-SYMBOL.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `STATS-ACCOUNT` | `trade stats` | `--account --db --json` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/STATS-ACCOUNT.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `STATS-EMPTY` | `trade stats` | `--db` | **0**（各表前后相等） | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/STATS-EMPTY.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 期望来源：§0 分类规则 |
| `STATS-DAYS-BAD` | `trade stats` | `--days --db` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/STATS-DAYS-BAD.stdout` | **FAIL** | exit `0` · Δ **0**（各表前后相等） | **缺陷 D-05**：非数值天数不报错，却把报表清空成零笔。 ｜ 推导差异: exit 0 == 0 but the run expected a refusal |

## 模块七 · 现金分红 `dividend`

| OP-ID | 命令路径 | `flags` | 写库（实测前后行数差） | `--json` | 期望来源 | 证据 | 状态 | 实测摘要 | 备注 |
|---|---|---|---|:--:|:--:|---|---|---|---|
| `DIV-BEFORE-POS` | `trade position` | `--db --json --symbol` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DIV-BEFORE-POS.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 成本冲减实验的前值快照。 |
| `DIV-ADD-FULL` | `trade dividend add` | `--account --amount --date --db --notes --per-share --shares --symbol` | `dividends`+1 | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DIV-ADD-FULL.stdout` | **PASS** | exit `0` · Δ `dividends`+1 | 全参数登记分红成功。 |
| `DIV-ADD-MINIMAL` | `trade dividend add` | `--amount --db --symbol` | `dividends`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DIV-ADD-MINIMAL.stdout` | **PASS** | exit `0` · Δ `dividends`+1 | 只给标的与金额时账户落默认值，除息日默认今天。 |
| `DIV-ADD-JSON` | `trade dividend add` | `--account --amount --db --json --symbol` | `dividends`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DIV-ADD-JSON.stdout` | **PASS** | exit `0` · Δ `dividends`+1 |  |
| `DIV-ADD-NO-AMT` | `trade dividend add` | `--db --symbol` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DIV-ADD-NO-AMT.stdout` | **PASS** | exit `1` · Δ 建库 + 初始化 schema · stderr: ❌ 错误: 录入分红必须指定 --symbol 和 --amount 参数。 |  |
| `DIV-ADD-NO-SYM` | `trade dividend add` | `--amount --db` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DIV-ADD-NO-SYM.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 错误: 录入分红必须指定 --symbol 和 --amount 参数。 |  |
| `DIV-ADD-BAD-DATE` | `trade dividend add` | `--amount --date --db --symbol` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DIV-ADD-BAD-DATE.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 错误: Invalid ex_date format: not-a-date. Must be YYYY-MM-DD. | 非法日期被拒绝，文案给出格式要求。 |
| `DIV-ADD-UNKNOWN-SYM` | `trade dividend add` | `--amount --db --symbol` | `dividends`+1、`symbols`+1 | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DIV-ADD-UNKNOWN-SYM.stdout` | **PASS** | exit `0` · Δ `dividends`+1、`symbols`+1 | 笔误标的被归一化后仍然落库，并在 symbols 表新增一行，见观测 V-03。 期望来源：§0 分类规则 |
| `DIV-ADD-DRAFTFLAG` | `trade dividend add` | `--symbol --amount --date --account --shares --per-share --notes --db` | `dividends`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DIV-ADD-DRAFTFLAG.stdout` | **FAIL** | exit `0` · Δ `dividends`+1 | **缺陷 D-03**：草案里的参数在产品里并不存在，却被静默忽略并落库，除息日写成今天。 ｜ 推导差异: exit 0 == 0 but the run expected a refusal; a user-data table grew (no write was expected); delta dividends=1 != 0 |
| `DIV-LIST` | `trade dividend list` | `--db` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DIV-LIST.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 流水列表与累计分红合计；本行同时是 D-03 的对账依据。 |
| `DIV-LIST-SYMBOL` | `trade dividend list` | `--db --symbol` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DIV-LIST-SYMBOL.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `DIV-LIST-ACCOUNT` | `trade dividend list` | `--account --db` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DIV-LIST-ACCOUNT.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `DIV-LIST-JSON` | `trade dividend list` | `--db --json` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DIV-LIST-JSON.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `DIV-LIST-EMPTY` | `trade dividend list` | `--db` | **0**（各表前后相等） | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DIV-LIST-EMPTY.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 空库输出零笔与零金额。 期望来源：§0 分类规则 |
| `DIV-LIST-NEG` | `trade dividend list` | `--db --json` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DIV-LIST-NEG.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `DIV-AFTER-POS` | `trade position` | `--db --json --symbol` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DIV-AFTER-POS.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 后值快照；与观测量对比后见草案差异 D-15（分红不冲减摊薄成本）。 |

## 模块八 · 物理雷达 `physics` / `radar`

| OP-ID | 命令路径 | `flags` | 写库（实测前后行数差） | `--json` | 期望来源 | 证据 | 状态 | 实测摘要 | 备注 |
|---|---|---|---|:--:|:--:|---|---|---|---|
| `PHY-POSITIONAL` | `trade physics` | `--db` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/PHY-POSITIONAL.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 位置参数可用，输出速度、加速度、惯性质量、合力与置信度加权后的有效合力。 |
| `PHY-FLAG` | `trade physics` | `--db --symbol` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/PHY-FLAG.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `PHY-JSON` | `trade physics` | `--db --json --symbol` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/PHY-JSON.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | JSON 版含有效合力、换手率、置信度权重等字段。 |
| `PHY-MISSING` | `trade physics` | `--db` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/PHY-MISSING.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 错误: 请指定要分析的标的代码，例如: trade physics 600519 或 trade physics 518880.SH | 不给标的时报错并给出用法。 |
| `PHY-RADAR-ALIAS` | `trade radar` | `--db --json` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/PHY-RADAR-ALIAS.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） |  |
| `PHY-BAD-SYMBOL` | `trade physics` | `--db` | **0**（各表前后相等） | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/PHY-BAD-SYMBOL.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 未知代码不报错，样本数为零、现价为量级为零的占位值，调用方需自行判断，见观测 V-05。 期望来源：§0 分类规则 |
| `PHY-TWO-POS` | `trade physics` | `--db` | **0**（各表前后相等） | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/PHY-TWO-POS.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 给两个位置参数时只取第一个，第二个被静默忽略。 期望来源：§0 分类规则 |

## 模块九 · HTTP 服务 `serve` 与看板 `dashboard`

| OP-ID | 命令路径 | `flags` | 写库（实测前后行数差） | `--json` | 期望来源 | 证据 | 状态 | 实测摘要 | 备注 |
|---|---|---|---|:--:|:--:|---|---|---|---|
| `SERVE-SEED-DB` | `trade account add` | `--broker --db --name` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-SEED-DB.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `SERVE-SEED-BUY` | `trade lot buy` | `--account --db --price --qty --reason --symbol` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-SEED-BUY.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `SERVE-BIND-ANY0` | `trade serve` | `--db --host --port` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-BIND-ANY0.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 拒绝监听 0.0.0.0：trade serve 仅允许本地回环地址 (127.0.0.1 / localhost / ::1 / [::1])，以避免把完整投资账本暴露到外网。 | `--host 0.0.0.0` 被拒绝，且未建立任何监听。 |
| `SERVE-BIND-LAN` | `trade serve` | `--db --host --port` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-BIND-LAN.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 拒绝监听 192.168.31.44：trade serve 仅允许本地回环地址 (127.0.0.1 / localhost / ::1 / [::1])，以避免把完整投资账本暴露到外网。 | 局域网地址同样被拒绝。 |
| `SERVE-BIND-WILD` | `trade serve` | `--db --host --port` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-BIND-WILD.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 拒绝监听 *：trade serve 仅允许本地回环地址 (127.0.0.1 / localhost / ::1 / [::1])，以避免把完整投资账本暴露到外网。 | 通配地址同样被拒绝。 |
| `SERVE-START` | `trade serve` | `--db --host --port --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-START.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 主会话启动：仅绑定回环地址、生成会话凭据、由 SIGTERM 触发优雅停止。 |
| `SERVE-HEALTH` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-HEALTH.stdout` | **PASS** | HTTP `200` · Δ — | 公开探活端点：响应体只含版本、路径与运行时信息，不含任何持仓或账户字段。 |
| `SERVE-HEALTH-JSON-VERIFY` | `trade serve` | `—` | — | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-HEALTH-JSON-VERIFY.stdout` | **PASS** | HTTP `200` · Δ — |  |
| `SERVE-401-SUMMARY` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-401-SUMMARY.stdout` | **PASS** | HTTP `401` · Δ — | 缺少授权头时返回未授权状态，响应体为纯错误信息。 |
| `SERVE-401-LOTS` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-401-LOTS.stdout` | **PASS** | HTTP `401` · Δ — | 缺少授权头时返回未授权状态。 |
| `SERVE-401-SUMMARY-WRONGTOK` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-401-SUMMARY-WRONGTOK.stdout` | **PASS** | HTTP `401` · Δ — | 错误凭据被拒绝。 |
| `SERVE-401-LOTS-WRONGTOK` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-401-LOTS-WRONGTOK.stdout` | **PASS** | HTTP `401` · Δ — | 错误凭据被拒绝。 |
| `SERVE-200-SUMMARY` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-200-SUMMARY.stdout` | **PASS** | HTTP `200` · Δ — | 正确凭据放行并返回组合快照。 |
| `SERVE-200-LOTS` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-200-LOTS.stdout` | **PASS** | HTTP `200` · Δ — | 正确凭据放行并返回批次明细。 |
| `SERVE-200-LOTS-FILTER` | `trade serve` | `—` | — | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-200-LOTS-FILTER.stdout` | **PASS** | HTTP `200` · Δ — | 服务端过滤生效并回显过滤条件。 |
| `SERVE-200-LOTS-FILTER-NONE` | `trade serve` | `—` | — | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-200-LOTS-FILTER-NONE.stdout` | **PASS** | HTTP `200` · Δ — | 过滤到不存在的标的返回成功加空列表，而非未找到。 |
| `SERVE-200-QUERYTOKEN` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-200-QUERYTOKEN.stdout` | **PASS** | HTTP `200` · Δ — | 查询串传参的鉴权方式同样有效。 |
| `SERVE-401-QUERYTOKEN-BAD` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-401-QUERYTOKEN-BAD.stdout` | **PASS** | HTTP `401` · Δ — | 错误查询串凭据被拒绝。 |
| `SERVE-HOST-FORGERY` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-HOST-FORGERY.stdout` | **PASS** | HTTP `403` · Δ — | 伪造主机头被拒绝，属 DNS rebinding 防护。 |
| `SERVE-HOST-FORGERY-LOTS` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-HOST-FORGERY-LOTS.stdout` | **PASS** | HTTP `403` · Δ — | 即使携带正确凭据，伪造主机头仍被拒绝，说明主机头门独立生效。 |
| `SERVE-HOST-OK` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-HOST-OK.stdout` | **PASS** | HTTP `200` · Δ — | 合法主机头放行，证明上一行不是误杀。 |
| `SERVE-ORIGIN-BAD` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-ORIGIN-BAD.stdout` | **PASS** | HTTP `403` · Δ — | 非法来源被拒绝，且响应不含跨域放行头。 |
| `SERVE-ORIGIN-GOOD` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-ORIGIN-GOOD.stdout` | **PASS** | HTTP `200` · Δ — | 白名单内的回环来源放行并回跨域放行头。 |
| `SERVE-ORIGIN-LOCALHOST` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-ORIGIN-LOCALHOST.stdout` | **PASS** | HTTP `200` · Δ — | 本地域名来源在白名单内。 |
| `SERVE-ORIGIN-NULL` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-ORIGIN-NULL.stdout` | **PASS** | HTTP `200` · Δ — | 本地文件页面的空来源在白名单内。 |
| `SERVE-PREFLIGHT-OPTIONS` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-PREFLIGHT-OPTIONS.stdout` | **PASS** | HTTP `204` · Δ — | 预检请求返回无内容状态并回跨域方法与头部信息。 |
| `SERVE-METHOD-POST` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-METHOD-POST.stdout` | **PASS** | HTTP `405` · Δ — | 写方法打到只读引擎上被拒绝。 |
| `SERVE-METHOD-DELETE` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-METHOD-DELETE.stdout` | **PASS** | HTTP `405` · Δ — | 删除方法即使带正确凭据也被拒绝。 |
| `SERVE-UNKNOWN-ENDPOINT` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-UNKNOWN-ENDPOINT.stdout` | **PASS** | HTTP `401` · Δ — | 未知端点且无凭据时先被鉴权门拦下。 |
| `SERVE-UNKNOWN-ENDPOINT-AUTH` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-UNKNOWN-ENDPOINT-AUTH.stdout` | **PASS** | HTTP `404` · Δ — | 未知端点带正确凭据时返回未找到；两行合起来说明无凭据者无法区分端点是否存在，见观测 V-06。 |
| `SERVE-TRAVERSAL` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-TRAVERSAL.stdout` | **PASS** | HTTP `404` · Δ — | 路径穿越请求返回未找到，未越界。 |
| `SERVE-EXPLICIT-TOKEN` | `trade serve` | `--db --host --port --token --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-EXPLICIT-TOKEN.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 显式口令加既有外部凭据文件：启动时覆写该文件内容，停机后文件仍在，不删除外部凭据。 |
| `SERVE-EXPLICIT-TOKEN-200` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-EXPLICIT-TOKEN-200.stdout` | **PASS** | HTTP `200` · Δ — | 用显式口令访问受保护端点成功。 |
| `SERVE-BIND-LOCALHOST` | `trade serve` | `--db --host --json --port --token --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-BIND-LOCALHOST.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | `--host localhost` 被接受；实际内核绑定与可达性见同名审计文件。 |
| `SERVE-BIND-LOCALHOST-HEALTH-V4` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-BIND-LOCALHOST-HEALTH-V4.stdout` | **PASS** | HTTP `200` · Δ — |  |
| `SERVE-BIND-IPV6LOOP` | `trade serve` | `--db --host --json --port --token --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-BIND-IPV6LOOP.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | `--host ::1` 被接受；实际只绑定 IPv6 回环，且公告的 URL 字面量缺少方括号，见观测 V-07。 |
| `SERVE-BIND-IPV6LOOP-HEALTH-V6` | `trade serve` | `—` | — | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-BIND-IPV6LOOP-HEALTH-V6.stdout` | **PASS** | HTTP `NO_RESPONSE` · Δ — | 用 IPv4 回环探测 IPv6-only 监听，连接被拒（预期，作为绑定范围的旁证）。 |
| `SERVE-JSON-READY` | `trade serve` | `--db --host --json --port --token --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-JSON-READY.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | `--json` 在启动时输出一行机器可读的 ready 信息，停机时再追加一行 stopped。 |
| `SERVE-JSON-READY-HEALTH` | `trade serve` | `—` | — | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-JSON-READY-HEALTH.stdout` | **PASS** | HTTP `200` · Δ — |  |
| `SERVE-QUIET` | `trade serve` | `--db --host --port --quiet --token --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-QUIET.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | `--quiet` 抑制启动横幅。 |
| `SERVE-QUIET-HEALTH` | `trade serve` | `—` | — | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-QUIET-HEALTH.stdout` | **PASS** | HTTP `200` · Δ — |  |
| `SERVE-PORT0` | `trade serve` | `--db --host --json --port --token-file` | — | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-PORT0.stdout` | **BLOCKED** | exit `BLOCKED` · Δ — | **BLOCKED — 缺失能力**：`--port 0` 让操作系统分配临时端口，实测会落到 18000–18999 之外；R2 返工书要求端口限定在该区间且不得使用 `--port 0`，因此本行不再执行。 期望来源：§0 分类规则 |
| `SERVE-PORT0-HEALTH` | `trade serve` | `—` | — | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-PORT0-HEALTH.stdout` | **BLOCKED** | exit `BLOCKED` · Δ — | **BLOCKED — 缺失能力**：依赖上一行的会话，本行随之 BLOCKED。 期望来源：§0 分类规则 |
| `SERVE-PORT-CONFLICT-HOLDER` | `trade serve` | `--db --host --json --port --token --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-PORT-CONFLICT-HOLDER.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 端口占用实验的占位会话。 |
| `SERVE-PORT-CONFLICT-SECOND` | `trade serve` | `--db --host --port --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-PORT-CONFLICT-SECOND.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 端口 18974 已被占用，本地引擎无法在 127.0.0.1:18974 启动。 | 端口冲突时给出可读排查文案，且没有堆栈外泄。 |
| `SERVE-SIGINT` | `trade serve` | `--db --host --json --port --token --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-SIGINT.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | SIGINT 优雅停机：输出停止信息、释放端口。 |
| `SERVE-ENTROPY-1` | `trade serve` | `--db --host --json --port --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-ENTROPY-1.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 随机凭据样本之一。 |
| `SERVE-ENTROPY-2` | `trade serve` | `--db --host --json --port --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-ENTROPY-2.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 随机凭据样本之二。 |
| `SERVE-ENTROPY-3` | `trade serve` | `--db --host --json --port --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-ENTROPY-3.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 随机凭据样本之三。 |
| `SERVE-DEFAULT-TOKENFILE` | `trade serve` | `--db --host --json --port` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-DEFAULT-TOKENFILE.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 把 HOME 重定向到沙箱后不传凭据文件参数：产品按默认路径写凭据，证明默认路径的派生方式，且真实凭据目录全程未被触碰。 |
| `SERVE-8080-LINKED` | `trade serve` | `--db --host --port --token-file` | — | 是 | L5 `E2E-N-96`（`dashboard --help` 声明 `--api-base`；产物探活基址 = 传入值） | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-8080-LINKED.stdout`（原 BLOCKED 判定）；解除依据：`docs/qa/evidence/tp-5a3bfad8-L2-20261026-103214-commit-c895274f/E2E-N-96.json` | **PASS** | exit `0` · Δ **0**（各表前后相等） | **已解除（D-08 修复，`c895274`）**：看板探活基址改由 `--api-base <url>` 提供，可用 18000–18999 内的实际端口覆盖，不再需要 8080 授权。L5 实测 `LOCAL_API_BASE = 'http://127.0.0.1:18436'`（= 传入值）、六表 Δ 0。 |
| `SERVE-DUAL-MODE-GREENLIGHT` | `trade serve` | `—` | — | 是 | L5 `E2E-N-97`（双模冒烟：顶栏转绿 + 停机平滑降级） | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-DUAL-MODE-GREENLIGHT.stdout`（原 BLOCKED 判定）；解除依据：`docs/qa/evidence/tp-5a3bfad8-L2-20261026-103214-commit-c895274f/E2E-N-97.json` | **PASS** | exit `0` · Δ **0**（各表前后相等） | **已解除（`c895274`）**：无头浏览器在本线可用（`E2E-P-17` 已在用），叠加的固定端口阻塞随 D-08 一并消失。L5 实测 serve(18186) + `--api-base` → 顶栏 `class=local` +「本地引擎已联动」，停机后同页降级 `standalone`，两态 DOM >1000 字符且 NaN=0。 |
| `SERVE-DEG-SEED` | `trade account add` | `--db --name` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-DEG-SEED.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `SERVE-DEG-BUY` | `trade lot buy` | `--account --db --price --qty --symbol` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-DEG-BUY.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `SERVE-DEG-CLOSE` | `trade lot close` | `--db --lot-id --price` | `trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-DEG-CLOSE.stdout` | **PASS** | exit `0` · Δ `trades`+1 |  |
| `SERVE-DEGRADED-EMPTY` | `trade serve` | `--db --host --json --port --token --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-DEGRADED-EMPTY.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 空库不误报降级。 |
| `SERVE-DEGRADED-EMPTY-SUMMARY` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-DEGRADED-EMPTY-SUMMARY.stdout` | **PASS** | HTTP `200` · Δ — |  |
| `SERVE-DEGRADED-ORPHAN` | `trade serve` | `--db --host --json --port --token --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-DEGRADED-ORPHAN.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 成交流水存在而批次表被清空时报降级并给出原因，不把异常静默当空仓。 |
| `SERVE-DEGRADED-ORPHAN-SUMMARY` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-DEGRADED-ORPHAN-SUMMARY.stdout` | **PASS** | HTTP `200` · Δ — |  |
| `SERVE-DEGRADED-ORPHAN-HEALTH` | `trade serve` | `—` | — | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/SERVE-DEGRADED-ORPHAN-HEALTH.stdout` | **PASS** | HTTP `200` · Δ — |  |
| `DASH-SEED` | `trade account add` | `--broker --db --name` | 建库 + 初始化 schema | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DASH-SEED.stdout` | **PASS** | exit `0` · Δ 建库 + 初始化 schema |  |
| `DASH-SEED-BUY` | `trade lot buy` | `--account --db --price --qty --reason --symbol` | `lots`+1、`trades`+1 | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DASH-SEED-BUY.stdout` | **PASS** | exit `0` · Δ `lots`+1、`trades`+1 |  |
| `DASH-OUT-NONE` | `trade dashboard` | `--db --out --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DASH-OUT-NONE.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 缺少活跃凭据时页面回落独立模式并在终端明确提示。 |
| `DASH-OUT-JSON` | `trade dashboard` | `--db --json --out --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DASH-OUT-JSON.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | `--json` 返回产物路径、字节数与打开状态。 |
| `DASH-OUT-TOKEN` | `trade dashboard` | `--db --json --out --token --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DASH-OUT-TOKEN.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 内联口令被写进生成页的凭据占位符。 |
| `DASH-OUT-TOKENFILE` | `trade dashboard` | `--db --json --out --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DASH-OUT-TOKENFILE.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 从凭据文件读取口令并注入。 |
| `DASH-OUT-TEMPLATE` | `trade dashboard` | `--db --json --out --template --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DASH-OUT-TEMPLATE.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 模板标记只出现在使用自定义模板生成的产物里，证明模板参数生效。 |
| `DASH-TEMPLATE-MISS` | `trade dashboard` | `--db --out --template` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DASH-TEMPLATE-MISS.stdout` | **PASS** | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 生成看板失败: Template not found: /tmp/qa-tp5a3bfad8-L1r2-20261022-222110/definitely-absent.html | 模板不存在时给出明确错误。 |
| `DASH-OUT-BADDIR` | `trade dashboard` | `--db --out --token-file` | **0**（各表前后相等） | 是 | help | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DASH-OUT-BADDIR.stdout` | **FAIL** | exit `1` · Δ **0**（各表前后相等） · stderr: Traceback (most recent call last): | **缺陷 D-04**：输出目录不存在时先喷出解释器 traceback，再补友好错误。 ｜ 推导差异: forbidden text /Traceback/ present |
| `DASH-OUT-DOT` | `trade dashboard` | `--db --json --out --token-file` | **0**（各表前后相等） | 是 | 规则文档 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DASH-OUT-DOT.stdout` | **PASS** | exit `0` · Δ **0**（各表前后相等） | 输出路径中的当前目录段被正常归一化。 |
| `DASH-OPEN` | `trade dashboard` | `--db --open --out --token-file` | — | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DASH-OPEN.stdout` | **BLOCKED** | exit `BLOCKED` · Δ — | **BLOCKED — 缺失能力**：`--open` 会拉起系统默认浏览器，属沙箱外 GUI 副作用，无法产出机器可读证据。 期望来源：§0 分类规则 |
| `DASH-DEFAULT-OUT` | `trade dashboard` | `--db --out --token-file` | — | 是 | §0 分类规则 | `docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/DASH-DEFAULT-OUT.stdout` | **BLOCKED** | exit `BLOCKED` · Δ — | **BLOCKED — 缺失能力**：省略输出路径会把产物写进仓库根，污染被测工作区与被保护文件的哈希。 期望来源：§0 分类规则 |

---

## 11. 守卫清单（G-xx）

`G-01`~`G-44` 的类型与触发条件与第 1 轮一致（逐条对照见 §16）；`G-45`（价格有限正数）与 `G-46`（数值旗标字面量层）为后续 L1/L5 新增守卫。**本清单合计 46 条（`G-01`~`G-46`）**，严格成对类型（拦截 / 状态转换 / 错误码映射）全部成对（checker `unpaired=0`）。违规侧与合法侧结论都由推导得出，不留占位符。

| G-ID | 类型 | 所属操作行 | 触发条件 | 预期输出 | 实测摘要（证据原文摘录） | 违规侧结论 | 合法侧结论 | 两侧归类理由 | 证据 |
|---|---|---|---|---|---|---|---|---|---|
| **G-01** | 安全门 | 全部操作行 | 任一 trade 调用未带 `--db /tmp/...`，或内联 HOME 指向沙箱之外 | 采集器在执行前拒绝，并把带时间戳与 op id 的拒绝行追加进违规文件；被拒调用不得进入 commands.log | `ZZ-GUARD-SELFTEST-MISSING-DB`: exit `GUARD_VIOLATION` · Δ — <br>`ZZ-GUARD-SELFTEST-BAD-HOME`: exit `GUARD_VIOLATION` · Δ — <br>`ZZ-GUARD-SELFTEST-HOME-CONTROL`: exit `0` · Δ **0**（各表前后相等） | 违规侧：全部按预期处理（含标记/告警类） | 合法侧：全部放行，未被误杀 | 违规侧＝未带沙箱 `--db` 或 HOME 越界的调用（守卫应拒绝）；合法侧＝带齐沙箱参数的调用（应放行并正常执行）。 | `harness-guard-violations.txt`、`ZZ-GUARD-SELFTEST-MISSING-DB.stdout`、`ZZ-GUARD-SELFTEST-BAD-HOME.stdout` |
| **G-02** | 安全门 | `G-DB-OVER-ENV` `G-DB-BEFORE-SUBCMD` `G-DB-BAD-PARENT` | 同时给出环境变量与显式 `--db` | `--db` 胜出；`--db` 位置无关；指向不存在的目录时自动建目录建库 | `G-DB-OVER-ENV`: exit `0` · Δ **0**（各表前后相等） <br>`G-DB-BEFORE-SUBCMD`: exit `0` · Δ 建库 + 初始化 schema <br>`G-DB-BAD-PARENT`: exit `0` · Δ 建库 + 初始化 schema | 违规侧：无对应请求 | 合法侧：全部放行，未被误杀 | 违规侧＝环境变量压过 `--db` 的情形（守卫应让 `--db` 胜出）；合法侧＝显式 `--db` 的正常调用（应放行并按该库执行）。 | `G-DB-OVER-ENV.stdout`、`G-DB-BEFORE-SUBCMD.stdout`、`G-DB-BAD-PARENT.stdout`、`G-DB-BAD-PARENT.rows-after.txt` |
| **G-03** | 安全门 | `G-ENV-LOTDB-WINS` `G-ENV-TRADEDB-FALLBACK` `G-DEFAULT-DB-PATH` | 需要在**不带 `--db`** 的前提下观测环境变量与默认路径回退 | 优先级链为 `--db > LOT_TRADER_DB > TRADE_DB_PATH > 默认路径`：命令带 `--db` 时取 `--db`；不带时依次取两个环境变量；都不设时落到默认路径 | `G-ENV-LOTDB-WINS`: exit `BLOCKED` · Δ — <br>`G-ENV-TRADEDB-FALLBACK`: exit `BLOCKED` · Δ — <br>`G-DEFAULT-DB-PATH`: exit `BLOCKED` · Δ — <br>本守卫引用的 op 全部 BLOCKED；缺失能力：需要一次**不带 `--db`** 的调用才能观测环境变量之间的优先级，与本话题隔离规则冲突；建议 L2 在 HOME 与三个环境变量全部重定向到沙箱后单独授权一次。 | 违规侧：无对应请求 | 合法侧：BLOCKED（见 §14.3） | 本守卫的三条 op 全部 BLOCKED，两侧都构造不出：需要一次不带 `--db` 的调用。 | `G-ENV-LOTDB-WINS.stdout`、`G-ENV-TRADEDB-FALLBACK.stdout`、`G-DEFAULT-DB-PATH.stdout` |
| **G-04** | 安全门 | `SERVE-BIND-ANY0` `SERVE-BIND-LAN` `SERVE-BIND-WILD` `SERVE-BIND-LOCALHOST` `SERVE-BIND-IPV6LOOP` | `--host` 取非回环地址；或取允许的本地别名 | 非回环地址拒绝启动；回环别名接受并只在回环范围内监听 | `SERVE-BIND-ANY0`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 拒绝监听 0.0.0.0：trade serve 仅允许本地回环地址 (127.0.0.1 / localhost / ::1 / [::1])，以避免把完整投资账本暴露到外网。 <br>`SERVE-BIND-LAN`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 拒绝监听 192.168.31.44：trade serve 仅允许本地回环地址 (127.0.0.1 / localhost / ::1 / [::1])，以避免把完整投资账本暴露到外网。 <br>`SERVE-BIND-WILD`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 拒绝监听 *：trade serve 仅允许本地回环地址 (127.0.0.1 / localhost / ::1 / [::1])，以避免把完整投资账本暴露到外网。 <br>`SERVE-BIND-LOCALHOST`: exit `0` · Δ **0**（各表前后相等） <br>`SERVE-BIND-IPV6LOOP`: exit `0` · Δ **0**（各表前后相等） <br>`SERVE-BIND-LOCALHOST-HEALTH-V4`: HTTP `200` · Δ — | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝非回环 host（应拒绝启动）；合法侧＝回环别名 host（应放行并完成绑定与监听）。 | `SERVE-BIND-ANY0.stderr`、`SERVE-BIND-WILD.stderr`、`SERVE-BIND-LOCALHOST.bindings.txt`、`SERVE-BIND-IPV6LOOP.bindings.txt` |
| **G-05** | 安全门 | `SERVE-START` `SERVE-DEFAULT-TOKENFILE` | 自动生成会话凭据 | 凭据文件为仅当前用户可读写，内容为高熵随机值 | `SERVE-START`: exit `0` · Δ **0**（各表前后相等） <br>`SERVE-DEFAULT-TOKENFILE`: exit `0` · Δ **0**（各表前后相等） | 违规侧：无对应请求 | 合法侧：全部放行，未被误杀 | 违规侧＝凭据文件权限/随机性不达标（应被判定为不合规）；合法侧＝正常生成凭据并完成 0600 落盘。 | `SERVE-TOKENFILE-AUDIT.txt`、`SERVE-DEFAULT-TOKENFILE-AUDIT.txt` |
| **G-06** | 安全门 | `SERVE-401-*` | 访问受保护端点时缺少凭据、凭据错误，或查询串凭据错误 | 返回未授权状态 | `SERVE-401-SUMMARY`: HTTP `401` · Δ — <br>`SERVE-401-LOTS`: HTTP `401` · Δ — <br>`SERVE-401-SUMMARY-WRONGTOK`: HTTP `401` · Δ — <br>`SERVE-401-LOTS-WRONGTOK`: HTTP `401` · Δ — <br>`SERVE-401-QUERYTOKEN-BAD`: HTTP `401` · Δ — <br>`SERVE-200-SUMMARY`: HTTP `200` · Δ — <br>`SERVE-200-LOTS`: HTTP `200` · Δ — <br>`SERVE-200-QUERYTOKEN`: HTTP `200` · Δ — | 违规侧：全部按预期处理（含标记/告警类） | 合法侧：全部放行，未被误杀 | 违规侧＝无/错凭据请求受保护端点（应返回未授权）；合法侧＝正确凭据请求（应放行并返回数据）。 | `http-probes.log`、`SERVE-401-SUMMARY.headers.txt` |
| **G-07** | 安全门 | `SERVE-401-*` | 未授权响应体 | 只含错误信息，不得出现任何账本字段 | `SERVE-401-SUMMARY`: HTTP `401` · Δ — <br>`SERVE-401-LOTS`: HTTP `401` · Δ — <br>`SERVE-401-SUMMARY-WRONGTOK`: HTTP `401` · Δ — <br>`SERVE-401-LOTS-WRONGTOK`: HTTP `401` · Δ — <br>`SERVE-401-QUERYTOKEN-BAD`: HTTP `401` · Δ — <br>`SERVE-401-SUMMARY` ⇒ 「"code": "UNAUTHORIZED"」 | 违规侧：全部按预期处理（含标记/告警类） | 合法侧：无对应请求 | 违规侧＝未授权响应体（应不含账本字段）；合法侧＝无对应请求（本守卫只约束错误响应体本身）。 | `SERVE-401-LEAK-AUDIT.txt`、`SERVE-401-SUMMARY.body.txt` |
| **G-08** | 错误码映射 | `SERVE-HOST-FORGERY` `SERVE-HOST-FORGERY-LOTS` `SERVE-HOST-OK` | 伪造 Host 头 | 拒绝请求；携带正确凭据也拒绝；合法 Host 正常放行 | `SERVE-HOST-FORGERY`: HTTP `403` · Δ — <br>`SERVE-HOST-FORGERY-LOTS`: HTTP `403` · Δ — <br>`SERVE-HOST-OK`: HTTP `200` · Δ — <br>`SERVE-HOST-FORGERY` ⇒ 「"code": "HOST_NOT_ALLOWED"」 | 违规侧：全部按预期处理（含标记/告警类） | 合法侧：全部放行，未被误杀 | 违规侧＝伪造 Host（应拒绝）；合法侧＝合法 Host（应放行并正常应答）。 | `SERVE-HOST-FORGERY.body.txt`、`SERVE-HOST-OK.headers.txt` |
| **G-09** | 错误码映射 | `SERVE-ORIGIN-BAD` `SERVE-ORIGIN-GOOD` `SERVE-ORIGIN-LOCALHOST` `SERVE-ORIGIN-NULL` | Origin 不在本地白名单内 | 拒绝请求且不回跨域放行头；白名单内来源正常放行并回放行头 | `SERVE-ORIGIN-BAD`: HTTP `403` · Δ — <br>`SERVE-ORIGIN-GOOD`: HTTP `200` · Δ — <br>`SERVE-ORIGIN-LOCALHOST`: HTTP `200` · Δ — <br>`SERVE-ORIGIN-NULL`: HTTP `200` · Δ — <br>`SERVE-ORIGIN-BAD` ⇒ 「"code": "ORIGIN_NOT_ALLOWED"」 | 违规侧：全部按预期处理（含标记/告警类） | 合法侧：全部放行，未被误杀 | 违规侧＝白名单外 Origin（应拒绝且不回放行头）；合法侧＝白名单内 Origin（应放行并回放行头）。 | `SERVE-ORIGIN-BAD.headers.txt`、`SERVE-401-LEAK-AUDIT.txt` |
| **G-10** | 错误码映射 | `SERVE-METHOD-POST` `SERVE-METHOD-DELETE` `SERVE-PREFLIGHT-OPTIONS` | 写方法打到只读引擎；或浏览器预检 | 写方法被拒；预检返回无内容并回跨域方法 | `SERVE-METHOD-POST`: HTTP `405` · Δ — <br>`SERVE-METHOD-DELETE`: HTTP `405` · Δ — <br>`SERVE-PREFLIGHT-OPTIONS`: HTTP `204` · Δ — <br>`SERVE-HEALTH`: HTTP `200` · Δ — | 违规侧：全部按预期处理（含标记/告警类） | 合法侧：全部放行，未被误杀 | 违规侧＝写方法与预检请求（应返回 405/204 这类特定响应）；合法侧＝普通 GET（应放行并返回 200）。 | `SERVE-METHOD-POST.status`、`SERVE-METHOD-DELETE.status`、`SERVE-PREFLIGHT-OPTIONS.headers.txt` |
| **G-11** | 错误码映射 | `SERVE-UNKNOWN-ENDPOINT` `SERVE-UNKNOWN-ENDPOINT-AUTH` `SERVE-TRAVERSAL` | 请求不存在的端点或路径穿越 | 无凭据时先被鉴权门拦下；带凭据时未找到；穿越请求不越界 | `SERVE-UNKNOWN-ENDPOINT`: HTTP `401` · Δ — <br>`SERVE-UNKNOWN-ENDPOINT-AUTH`: HTTP `404` · Δ — <br>`SERVE-TRAVERSAL`: HTTP `404` · Δ — <br>`SERVE-200-LOTS`: HTTP `200` · Δ — | 违规侧：全部按预期处理（含标记/告警类） | 合法侧：全部放行，未被误杀 | 违规侧＝未知端点与路径穿越（应返回 401/404）；合法侧＝带凭据的正常请求（应放行并返回数据）。 | `SERVE-UNKNOWN-ENDPOINT-AUTH.status`、`SERVE-TRAVERSAL.status` |
| **G-12** | 状态转换 | `SERVE-START` `SERVE-SIGINT` `SERVE-QUIET` `SERVE-ENTROPY-1` `SERVE-ENTROPY-2` `SERVE-ENTROPY-3` | 收到 SIGTERM 或 SIGINT | 优雅停机：进程正常退出、端口释放、自动生成的凭据文件被删除 | `SERVE-START`: exit `0` · Δ **0**（各表前后相等） <br>`SERVE-SIGINT`: exit `0` · Δ **0**（各表前后相等） <br>`SERVE-QUIET`: exit `0` · Δ **0**（各表前后相等） <br>`SERVE-ENTROPY-1`: exit `0` · Δ **0**（各表前后相等） <br>`SERVE-ENTROPY-2`: exit `0` · Δ **0**（各表前后相等） <br>`SERVE-ENTROPY-3`: exit `0` · Δ **0**（各表前后相等） <br>**pair_na**：本守卫断言的是「收到信号后进程优雅退出、端口释放、自动生成的凭据被删除」。这三个事实都只能在停机**之后**观测，任何 serve 会话本身都不构成应被拒绝的输入——产品没有哪个参数能让停机变成不优雅，因此违规侧构造不出来。本轮停机事实：非零退出的会话全部发生在建立监听之前（分布见紧随其后的实测摘要），与停机路径无关。（本轮实测：serve 会话退出码分布 exit 0×14、exit 1×4；非零退出的是 SERVE-BIND-ANY0、SERVE-BIND-LAN、SERVE-BIND-WILD、SERVE-PORT-CONFLICT-SECOND，全部发生在建立监听之前，与停机路径无关。） | 违规侧：pair_na（无法构造违规输入，理由见实测摘要） | 合法侧：全部放行，未被误杀 | 两侧都以「放行并完成优雅停机」为预期，因此没有应被拒绝的输入：违规侧 pair_na。 | `SERVE-PORT-RELEASE.txt`、`SERVE-SIGINT-AUDIT.txt`、`SERVE-TOKEN-ENTROPY-COUNT.txt` |
| **G-13** | 状态转换 | `SERVE-EXPLICIT-TOKEN` | 显式口令加已存在的外部凭据文件 | 停机不删除外部凭据文件 | `SERVE-EXPLICIT-TOKEN`: exit `0` · Δ **0**（各表前后相等） <br>`SERVE-EXPLICIT-TOKEN-200`: HTTP `200` · Δ — <br>**pair_na**：产品只在凭据由自己生成时才删除它（SERVE-ENTROPY-1/2/3 即该路径），不存在任何输入能让它对**外部**凭据文件执行删除；本轮唯一带外部凭据文件的会话就是合法侧本身，因此违规侧构造不出来。 | 违规侧：pair_na（无法构造违规输入，理由见实测摘要） | 合法侧：全部放行，未被误杀 | 产品只在凭据由自己生成时才删除，外部凭据文件没有可被触发删除的输入：违规侧 pair_na。 | `SERVE-EXTERNAL-TOKEN-AUDIT.txt` |
| **G-14** | 拦截 | `SERVE-DEGRADED-EMPTY` `SERVE-DEGRADED-ORPHAN` | 账本结构异常：有成交流水但批次表为空 | 报降级并给出原因；空库不误报降级 | `SERVE-DEGRADED-ORPHAN`: exit `0` · Δ **0**（各表前后相等） <br>`SERVE-DEGRADED-ORPHAN-SUMMARY`: HTTP `200` · Δ — <br>`SERVE-DEGRADED-ORPHAN-HEALTH`: HTTP `200` · Δ — <br>`SERVE-DEGRADED-EMPTY`: exit `0` · Δ **0**（各表前后相等） <br>`SERVE-DEGRADED-EMPTY-SUMMARY`: HTTP `200` · Δ — <br>`SERVE-DEGRADED-EMPTY-SUMMARY` ⇒ 「"degraded": false」 <br>`SERVE-DEGRADED-ORPHAN-SUMMARY` ⇒ 「"degraded": true」 | 违规侧：全部按预期处理（含标记/告警类） | 合法侧：全部放行，未被误杀 | 违规侧＝账本结构异常的库（应触发降级标记）；合法侧＝空库（应放行且不误报降级）。 | `SERVE-DEGRADED-EMPTY-SUMMARY.body.txt`、`SERVE-DEGRADED-ORPHAN-SUMMARY.body.txt` |
| **G-15** | 拦截 | `RISK-BLOCK-OVER` `RISK-BLOCK-XL` `BUY-RISK-WOULD-BLOCK` | 买入后单标的估值占组合比例越过硬顶线 | 拒绝买入、退出码非零、批次数不变 | `RISK-BLOCK-OVER`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 单标的持仓硬顶风控拦截：买入后标的 159937.SZ 估算持仓占比为 33.33%，超过 30.00% 组合级硬顶红线 (标的总额 1400.00 / 组合总值 4200.00)！ <br>`RISK-BLOCK-XL`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 单标的持仓硬顶风控拦截：买入后标的 600519.SH 估算持仓占比为 97.92%，超过 30.00% 组合级硬顶红线 (标的总额 131849.00 / 组合总值 134649.00)！ <br>`BUY-RISK-WOULD-BLOCK`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 单标的持仓硬顶风控拦截：买入后标的 600519.SH 估算持仓占比为 41.07%，超过 30.00% 组合级硬顶红线 (标的总额 10000.00 / 组合总值 24350.00)！ <br>`RISK-PASS-UNDER`: exit `0` · Δ `lots`+1、`trades`+1 <br>`BUY-SKIP-RISK`: exit `0` · Δ `lots`+1、`trades`+1 | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝越线买入（应拒绝）；合法侧＝线内买入与显式旁路（应放行并完成落库）。 | `RISK-BLOCK-OVER.stderr`、`RISK-BLOCK-XL.stderr` |
| **G-16** | 拦截 | `RKE-EXACT-30PCT` `RKO-OVER-30PCT` | 占比恰好落在硬顶线上；或刚越过线上一点点 | 线上放行、越线拦截 | `RKO-OVER-30PCT`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 单标的持仓硬顶风控拦截：买入后标的 159915.SZ 估算持仓占比为 30.00%，超过 30.00% 组合级硬顶红线 (标的总额 3000.50 / 组合总值 10000.50)！ <br>`RKE-EXACT-30PCT`: exit `0` · Δ `lots`+1、`trades`+1 <br>`RKO-OVER-30PCT` ⇒ 「标的总额 3000.50 / 组合总值 10000.50」 | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝刚越线的买入（应拒绝）；合法侧＝恰好落在线上的买入（应放行并完成落库）。 | `RKO-OVER-30PCT.stderr`、`RKE-EXACT-30PCT.stdout` |
| **G-17** | 拦截（旁路） | `BUY-SKIP-RISK` `RISK-SKIP-RISK` `BUDGET-SKIP-RISK` | 显式传入跳过风控的参数 | 跳过前置风控检查并正常落库 | `BUY-RISK-WOULD-BLOCK`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 单标的持仓硬顶风控拦截：买入后标的 600519.SH 估算持仓占比为 41.07%，超过 30.00% 组合级硬顶红线 (标的总额 10000.00 / 组合总值 24350.00)！ <br>`RISK-BLOCK-OVER`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 单标的持仓硬顶风控拦截：买入后标的 159937.SZ 估算持仓占比为 33.33%，超过 30.00% 组合级硬顶红线 (标的总额 1400.00 / 组合总值 4200.00)！ <br>`BUY-SKIP-RISK`: exit `0` · Δ `lots`+1、`trades`+1 <br>`RISK-SKIP-RISK`: exit `0` · Δ `lots`+1、`trades`+1 <br>`BUDGET-SKIP-RISK`: exit `0` · Δ `lots`+1、`trades`+1 | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝同一参数不加旁路（应拒绝）；合法侧＝加了旁路参数（应放行并完成落库）。 | `BUY-RISK-WOULD-BLOCK.stderr`、`RISK-BLOCK-OVER.stderr`、`RISK-SKIP-RISK.stdout`、`BUDGET-SKIP-RISK.stdout` |
| **G-18** | 拦截（边界） | `RISK-BLOCK-OVER` `RKO-OVER-30PCT` `RISKSAME-HUGE` `RISKSAME-READBACK` | 在同一标的里持续累加到很大的金额，而组合中没有其他标的 | 该硬顶是跨标的组合窗口口径，不是单标的绝对金额上限，因此同标的累加不应触发它 | `RISK-BLOCK-OVER`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 单标的持仓硬顶风控拦截：买入后标的 159937.SZ 估算持仓占比为 33.33%，超过 30.00% 组合级硬顶红线 (标的总额 1400.00 / 组合总值 4200.00)！ <br>`RKO-OVER-30PCT`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 单标的持仓硬顶风控拦截：买入后标的 159915.SZ 估算持仓占比为 30.00%，超过 30.00% 组合级硬顶红线 (标的总额 3000.50 / 组合总值 10000.50)！ <br>`RISKSAME-HUGE`: exit `0` · Δ `lots`+1、`trades`+1 <br>`RISKSAME-READBACK`: exit `0` · Δ **0**（各表前后相等） | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝跨标的越线（应拒绝）；合法侧＝同标的累加（应放行并完成落库，这正是本守卫的命题）。 | `RISK-BLOCK-OVER.stderr`、`RKO-OVER-30PCT.stderr`、`RISKSAME-HUGE.stdout`、`RISKSAME-READBACK.stdout` |
| **G-19** | 拦截 | `ADD-COOLDOWN-BLOCK` | 同一血缘链在冷却窗口内再次加仓 | 拒绝加仓、文案给出冷却窗口与剩余时长、血缘链批次数不变 | `ADD-COOLDOWN-BLOCK`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 加仓失败: 加仓防抖冷却窗口守卫拦截：同源血缘链批次 LOT-20261022-001 (L1) 于 2026-10-22T14:21:28.028Z 已执行加仓，尚在 48 小时 (2 个交易日) 防抖冷却窗口内 (剩余 48.0 小 <br>`ADD-AFTER-48H`: exit `0` · Δ `lots`+1、`trades`+1 <br>`ADD-COOLDOWN-BLOCK` ⇒ 「于 2026-10-22T14:21:28.028Z 已执行加仓」 | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝冷却窗口内加仓（应拒绝）；合法侧＝窗口外加仓（应放行并生成子批次）。 | `ADD-COOLDOWN-BLOCK.stderr` |
| **G-20** | 状态转换 | `ADD-AFTER-48H` `ADD-P2-L1` | 血缘链最近一次加仓已在冷却窗口之外 | 放行并生成子批次，层级在父批次基础上递增 | `ADD-COOLDOWN-BLOCK`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 加仓失败: 加仓防抖冷却窗口守卫拦截：同源血缘链批次 LOT-20261022-001 (L1) 于 2026-10-22T14:21:28.028Z 已执行加仓，尚在 48 小时 (2 个交易日) 防抖冷却窗口内 (剩余 48.0 小 <br>`ADD-AFTER-48H`: exit `0` · Δ `lots`+1、`trades`+1 <br>`ADD-P2-L1`: exit `0` · Δ `lots`+1、`trades`+1 | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝冷却窗口内加仓（应拒绝）；合法侧＝窗口外加仓（应放行并生成子批次、层级递增）。 | `ADD-COOLDOWN-BLOCK.stderr`、`ADD-AFTER-48H.stdout`、`ADD-AFTER-48H-POS.stdout` |
| **G-21** | 拦截（可绕过） | `ADD-TIME-FORGERY` `ADD-FORGED-INVISIBLE` | 把本次加仓的成交时间写成未来值，从而让冷却判断以为已过窗口 | 未来成交时间应被拒绝：冷却判断应以真实时钟为准，`--time` 不得晚于现在 | `ADD-TIME-FORGERY`: exit `1` · Δ **0**（各表前后相等） · stdout: 「成交时间不得晚于当前时间：加仓成交时间 传入 … 晚于当前 …，已拒绝写入账本」 <br>`ADD-FORGED-INVISIBLE`: exit `1` · Δ **0**（同上一条守卫） <br>`ADD-AFTER-48H`: exit `0` · Δ `lots`+1、`trades`+1（窗口外真实时间回填仍放行） <br>L5 复核（`E2E-N-41`）: exit `1` · `lots` 2→2、`trades` 2→2；对照 `E2E-N-06`/`E2E-N-37`（48h 冷却期内真实时间加仓）仍 exit `1` · Δ 0，冷却守卫未被 D-01 修复削弱 | 违规侧：全部拦截/拒绝成功（两条伪造未来时间的加仓均 exit 1 且零写入，D-01 已修复） | 合法侧：全部放行，未被误杀 | 违规侧＝用未来成交时间绕过冷却的加仓（应拒绝）；合法侧＝真实时间上已过窗口的加仓（应放行并生成子批次）。 | `ADD-TIME-FORGERY.stdout`、`ADD-FORGED-INVISIBLE.stdout` |
| **G-22** | 拦截 | `BUY-NON-ROUND` `BUY-NEG-QTY` `BUY-ZERO-QTY` `ADD-NON-ROUND-QTY` | 股数不是最小交易单位的整数倍，或不是正数 | 拒绝建仓/加仓且不落库 | `BUY-NON-ROUND`: exit `1` · Δ **0**（各表前后相等） · stdout: 「--qty 必须是 100 股整数倍（一手 = 100 股），收到: 150 股」 <br>`BUY-NEG-QTY`: exit `1` · Δ **0**（各表前后相等） · stdout: 「--qty 必须为正整数股数（单位: 股），收到: -100」 <br>`BUY-ZERO-QTY`: exit `1` · Δ **0**（各表前后相等） · stdout: 「--qty 必须为正整数股数（单位: 股），收到: 0」 <br>`ADD-NON-ROUND-QTY`: exit `1` · Δ **0**（各表前后相等） · 同一文案（`--qty 必须是 100 股整数倍…`） <br>`BUY-OK-FLAGS`: exit `0` · Δ `lots`+1、`trades`+1 <br>`ADD-QTY-EXPLICIT`: exit `0` · Δ `lots`+1、`trades`+1 <br>L5 复核（`E2E-N-43`）: qty=150 / 0 / -100 三次均 exit `1` · 六表 Δ 0 | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝非整百/非正数量（应拒绝）；合法侧＝合法数量的建仓与加仓（应放行并完成落库）。 | `BUY-NON-ROUND.stderr`、`ADD-NON-ROUND-QTY.stderr` |
| **G-23** | 拦截 | `CLOSE-QTY-OVER` | 平仓数量超过剩余可用数量 | 拒绝平仓 | `CLOSE-QTY-OVER`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 平仓失败: 平仓数量 99999 超过剩余可用数量 4600 <br>`CLOSE-PARTIAL`: exit `0` · Δ `trades`+1 | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝超量平仓（应拒绝）；合法侧＝部分平仓（应放行并写入成交流水）。 | `CLOSE-QTY-OVER.stderr` |
| **G-24** | 拦截 | `CLOSE-ACCT-MISM` | 指定的账户与批次归属不符 | 拒绝平仓 | `CLOSE-ACCT-MISM`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 平仓失败: 批次账户不匹配：批次 LOT-20261022-001 属于账户 ACCA，而非指定的 ACCB <br>`CLOSE-ACCT-OK`: exit `0` · Δ `trades`+1 | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝账户不符的平仓（应拒绝）；合法侧＝账户相符的平仓（应放行并写入成交流水）。 | `CLOSE-ACCT-MISM.stderr`、`CLOSE-ACCT-OK.stdout` |
| **G-25** | 拦截 | `CLOSE-T1-LOCKED` `XACC-SUBCORE-NOFLAG` | 法定 T+1 标的当日买入、账户内没有历史底仓 | 拒绝平仓并提示可使用代冲参数 | `CLOSE-T1-LOCKED`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 平仓失败: 标的 510300.SH 为法定 T+1，当日买入份额无法直接平仓。若有可用底仓请指定 --substitute-core <br>`XACC-SUBCORE-NOFLAG`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 平仓失败: 标的 510300.SH 为法定 T+1，当日买入份额无法直接平仓。若有可用底仓请指定 --substitute-core <br>`CLOSE-SUBCORE-T1`: exit `0` · Δ `trades`+1 | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝法定 T+1 当日无底仓的平仓（应拒绝）；合法侧＝底仓充足时的代冲平仓（应放行并完成平仓转换）。 | `CLOSE-T1-LOCKED.stderr` |
| **G-26** | 状态转换 + 拦截 | `CLOSE-SUBCORE-T1` `XACC-SUBCORE-BLOCK` `XACC-SUBCORE-ALLOW` | 用代冲参数借用历史底仓卖出当日份额 | 同一账户且有底仓时放行；跨账户时拒绝，账户维度的可用配额独立计算 | `XACC-SUBCORE-BLOCK`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 平仓失败: 底仓可用配额不足，严防裸卖空！账户 XB 标的 510300.SH 总底仓 0 股，今日已代冲 0 股，剩余可用配额仅 0 股，申请代冲 200 股 <br>`XACC-SUBCORE-NOFLAG`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 平仓失败: 标的 510300.SH 为法定 T+1，当日买入份额无法直接平仓。若有可用底仓请指定 --substitute-core <br>`CLOSE-SUBCORE-T1`: exit `0` · Δ `trades`+1 <br>`XACC-SUBCORE-ALLOW`: exit `0` · Δ `trades`+1 <br>`XACC-SUBCORE-BLOCK` ⇒ 「账户 XB 标的 510300.SH 总底仓 0 股」 | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝跨账户借用底仓（应拒绝）；合法侧＝同账户底仓代冲（应放行并完成平仓转换）。 | `XACC-SUBCORE-BLOCK.stderr`、`XACC-SUBCORE-ALLOW.stdout` |
| **G-27** | 状态转换 | `CLOSE-TWICE` | 对已平仓批次再次平仓 | 拒绝重复平仓 | `CLOSE-TWICE`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 平仓失败: 批次 LOT-20261022-001 已经是 CLOSED 状态，不可重复平仓 <br>`CLOSE-FULL`: exit `0` · Δ `trades`+1 | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝重复平仓（应拒绝）；合法侧＝首次全额平仓（应放行并转为已平仓）。 | `CLOSE-TWICE.stderr` |
| **G-28** | 状态转换 | `EDIT-*` | 只修改决策理由 | 会计与状态字段零漂移，只有理由列变化 | `EDIT-REASON`: exit `0` · Δ **0**（各表前后相等） <br>`EDIT-BUY-REASON`: exit `0` · Δ **0**（各表前后相等） <br>`EDIT-CLOSE-REASON`: exit `0` · Δ **0**（各表前后相等） <br>`EDIT-APPEND`: exit `0` · Δ **0**（各表前后相等） <br>`EDIT-POSITIONAL`: exit `0` · Δ **0**（各表前后相等） <br>`EDIT-JSON`: exit `0` · Δ **0**（各表前后相等） <br>**pair_na**：`lot edit` 的入参只有理由字符串（`--reason` / `--buy-reason` / `--close-reason` / `--append`），没有任何一项指向价格、数量、费用或状态，因此构造不出会移动会计字段的输入。 | 违规侧：pair_na（无法构造违规输入，理由见实测摘要） | 合法侧：全部放行，未被误杀 | 本守卫的命题是「编辑不得移动会计字段」，编辑命令没有指向会计字段的入参：违规侧 pair_na。 | `EDIT-ACCT-SAFETY.before.txt`、`EDIT-ACCT-SAFETY.after.txt`、`EDIT-ACCT-SAFETY.diff.txt` |
| **G-29** | 状态转换 | `SCAN-DEEP-RUN` `SCAN-DEEP-CLOSE` `SCAN-ADD-RUN` | 跌幅越过深跌线 | 保持活跃、发出深跌告警、并且仍然可以正常平仓 | `SCAN-DEEP-RUN`: exit `0` · Δ `signals`+1 <br>`SCAN-DEEP-CLOSE`: exit `0` · Δ `trades`+1 <br>`SCAN-DEEP-AFTER`: exit `0` · Δ **0**（各表前后相等） <br>`SCAN-ADD-RUN`: exit `0` · Δ `signals`+1 <br>`SCAN-ADD-RUN` ⇒ 「ADD_POSITION_ALERT」 | 违规侧：全部按预期处理（含标记/告警类） | 合法侧：全部放行，未被误杀 | 违规侧＝深跌批次（应发深跌告警并保持活跃、仍可平仓）；合法侧＝回调批次（应放行且不得误发深跌告警）。 | `SCAN-DEEP-RUN.stdout`、`SCAN-DEEP-CLOSE-STATE.txt`、`SCAN-ADD-RUN.stdout` |
| **G-30** | 拦截 / 状态转换 | `SCAN-TRAIL-RUN` `SCAN-TRAIL-BELOW` `SCAN-TP-RUN` | 浮盈越过激活线且自峰值回撤越过阈值 | 命中移动止盈告警并给出建议股数 | `SCAN-TRAIL-RUN`: exit `0` · Δ `signals`+1 <br>`SCAN-TRAIL-BELOW`: exit `0` · Δ **0**（各表前后相等） <br>`SCAN-TP-RUN`: exit `0` · Δ `signals`+1 | 违规侧：全部按预期处理（含标记/告警类） | 合法侧：全部放行，未被误杀 | 违规侧＝回撤越线的批次（应触发移动止盈告警）；合法侧＝回撤未越线与只有止盈信号的批次（应放行且不得误报移动止盈）。 | `SCAN-TRAIL-BELOW-ASSERT.txt`、`SCAN-TRAIL-RUN.stdout`、`SCAN-TRAIL-INJECT.after.txt`、`SCAN-TP-RUN.stdout` |
| **G-31** | 拦截（负向防误杀） | `SCAN-TRAIL-BELOW` `SCAN-THR-DEFAULT` | 回撤低于阈值；或浮盈低于止盈线 | 不得误报告警 | `SCAN-TRAIL-RUN`: exit `0` · Δ `signals`+1 <br>`SCAN-THR-OVERRIDE`: exit `0` · Δ `signals`+1 <br>`SCAN-TRAIL-BELOW`: exit `0` · Δ **0**（各表前后相等） <br>`SCAN-THR-DEFAULT`: exit `0` · Δ **0**（各表前后相等） | 违规侧：全部按预期处理（含标记/告警类） | 合法侧：全部放行，未被误杀 | 违规侧＝越过阈值的输入（应触发告警）；合法侧＝未达阈值的输入（应放行且不告警）。 | `SCAN-TRAIL-BELOW-ASSERT.txt`、`SCAN-THR-DEFAULT.stdout` |
| **G-32** | 状态转换 | `SCAN-TP-RUN` `SCAN-T1LOCK-RUN` `SCAN-DT-RUN` `SCAN-ADD-RUN` | 按结算机制与账户内底仓可用量分流 | 天然 T+0 命中止盈；法定 T+1 当日无底仓命中锁定；补足底仓后命中日内代冲止盈；回调命中加仓 | `SCAN-TP-RUN`: exit `0` · Δ `signals`+1 <br>`SCAN-T1LOCK-RUN`: exit `0` · Δ `signals`+1 <br>`SCAN-DT-RUN`: exit `0` · Δ `signals`+1 <br>`SCAN-ADD-RUN`: exit `0` · Δ `signals`+1 <br>**pair_na**：分流没有参数入口：四类信号各由标的的结算机制与账户内底仓决定，产品没有能让分流走错的输入；四个分支（止盈 / T+1 锁定 / 日内代冲 / 回调加仓）互为对照。 | 违规侧：pair_na（无法构造违规输入，理由见实测摘要） | 合法侧：全部放行，未被误杀 | 本守卫的命题是「四类输入各自分流到正确分支」，没有应被拒绝的输入：违规侧 pair_na。 | `SCAN-DT-RUN.stdout`、`SCAN-ADD-RUN.stdout` |
| **G-33** | 状态转换 | `SCAN-THR-OVERRIDE` `SCAN-MENU-KEYS` | 用阈值覆盖参数调整止盈线 | 覆盖应生效，且 help 里给出的示例键必须可用 | `SCAN-MENU-KEYS`（照抄 `scan --help` **当前**示例 `{"take_profit_min":0.05,"dip_1":-0.08}`）: exit `0` · Δ `signals`+1（命中 `TAKE_PROFIT_ALERT`） <br>`SCAN-MENU-KEYS-OLD`（D-02 修复前 help 的旧键 `{"add":-0.1,"take":0.1}`）: exit `1` · Δ **0**（键名不在读取集内，D-07 校验生效） <br>`SCAN-THR-OVERRIDE`: exit `0` · Δ `signals`+1 <br>`SCAN-THR-DEFAULT`: exit `0` · Δ **0**（各表前后相等） <br>L5 复核（`E2E-N-65`）: 现场从 help 提取示例 → exit `0` 且 +10% 批次命中止盈；旧键 → exit `1` | 违规侧：全部按预期处理（照抄 help 示例即生效；D-02 修复前的旧键被 D-07 拒） | 合法侧：全部放行，未被误杀 | 违规侧＝阈值覆盖应生效的输入（含照抄 help 示例的那次）；合法侧＝默认阈值下的输入（应放行且不告警）。 | `SCAN-THR-OVERRIDE.stdout`、`SCAN-THR-DEFAULT.stdout`、`SCAN-MENU-KEYS.stdout` |
| **G-34** | 状态转换 | `DIV-BEFORE-POS` `DIV-ADD-FULL` `DIV-AFTER-POS` | 登记现金分红后读取持仓视图 | （本线实测：持仓成本字段不变）分红以累计现金形态出现，不冲减摊薄成本 | `DIV-BEFORE-POS`: exit `0` · Δ **0**（各表前后相等） <br>`DIV-ADD-FULL`: exit `0` · Δ `dividends`+1 <br>`DIV-AFTER-POS`: exit `0` · Δ **0**（各表前后相等） <br>**pair_na**：分红登记的参数是 help 列出的 `--symbol` / `--amount` / `--date` / `--account` / `--shares` / `--per-share` / `--notes`，没有任何一项指向成本字段；本守卫观测到的正是「成本字段不变」，所以构造不出能让它变的输入。 | 违规侧：pair_na（无法构造违规输入，理由见实测摘要） | 合法侧：全部放行，未被误杀 | 本守卫的命题是「分红不冲减成本」，分红入参没有指向成本字段的项：违规侧 pair_na。 | `DIV-COST-EFFECT-ASSERT.txt`、`DIV-COST-EFFECT.before.txt`、`DIV-COST-EFFECT.after.txt` |
| **G-35** | 安全门 | `DASH-OUT-*` | 生成单文件看板 | 产物仅当前用户可读写，且不依赖外部静态资源 | `DASH-OUT-NONE`: exit `0` · Δ **0**（各表前后相等） <br>`DASH-OUT-JSON`: exit `0` · Δ **0**（各表前后相等） <br>`DASH-OUT-TOKEN`: exit `0` · Δ **0**（各表前后相等） <br>`DASH-OUT-TOKENFILE`: exit `0` · Δ **0**（各表前后相等） <br>`DASH-OUT-TEMPLATE`: exit `0` · Δ **0**（各表前后相等） <br>`DASH-OUT-DOT`: exit `0` · Δ **0**（各表前后相等） | 违规侧：无对应请求 | 合法侧：全部放行，未被误杀 | 违规侧＝产物权限或外部依赖不合规（应被判不合规）；合法侧＝正常生成的单文件产物（应完成 0600 落盘且无外部依赖）。 | `DASH-ARTIFACT-FORENSICS.txt` |
| **G-36** | 安全门 | `DASH-OUT-TOKEN` `DASH-OUT-TOKENFILE` `DASH-OUT-NONE` | 有 / 无会话凭据 | 有凭据则注入页面，无凭据则留空并回落独立模式 | `DASH-OUT-TOKEN`: exit `0` · Δ **0**（各表前后相等） <br>`DASH-OUT-TOKENFILE`: exit `0` · Δ **0**（各表前后相等） <br>`DASH-OUT-NONE`: exit `0` · Δ **0**（各表前后相等） | 违规侧：无对应请求 | 合法侧：全部放行，未被误杀 | 违规侧＝有凭据却不注入或反之（应被判不合规）；合法侧＝按凭据有无正确注入或留空并回落独立模式。 | `DASH-ARTIFACT-FORENSICS.txt` |
| **G-37** | 状态转换 | `DASH-OUT-TEMPLATE` | 指定自定义模板 | 产出自指定模板 | `DASH-TEMPLATE-MISS`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 生成看板失败: Template not found: /tmp/qa-tp5a3bfad8-L1r2-20261022-222110/definitely-absent.html <br>`DASH-OUT-TEMPLATE`: exit `0` · Δ **0**（各表前后相等） <br>`DASH-OUT-NONE`: exit `0` · Δ **0**（各表前后相等） | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝无法兑现的模板路径（应报错）；合法侧＝可用模板（应放行并产出自该模板的页面）。 | `DASH-ARTIFACT-FORENSICS.txt`、`DASH-TEMPLATE-MISS.stderr` |
| **G-38** | 拦截 | `ACC-ADD-DUP` `ACC-ADD-BADBROKER` `ACC-ADD-NONAME` `ACC-ADD-BADCCY` | 重复账户 ID、非法券商、缺名称、非法币种 | 逐条拒绝且不落库 | `ACC-ADD-DUP`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 账户登记失败: 账户已存在: ACCA。如需修改请直接更新 accounts 表，避免重复登记。 <br>`ACC-ADD-BADBROKER`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 账户登记失败: 非法券商代码: "NOTABROKER"。可选值: CMB \| CITIC \| HTSC \| EASTMONEY \| GUOTAI \| YINHE \| GF \| PA \| FUTU \| IBKR \| CUSTOM <br>`ACC-ADD-NONAME`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 账户登记失败: Missing required arguments: <account_id> (or --id), --name <br>`ACC-ADD-BADCCY`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 账户登记失败: 非法币种: "NOTACURRENCY"。必须为 3 位 ISO 4217 代码，例如 CNY / HKD / USD。 <br>`ACC-ADD-ALPHA`: exit `0` · Δ `accounts`+1 <br>`ACC-ADD-BETA`: exit `0` · Δ `accounts`+1 <br>`ACC-ADD-GAMMA`: exit `0` · Δ `accounts`+1 | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝重复/非法账户字段（应拒绝）；合法侧＝合法字段（应放行并完成账户登记）。 | `ACC-ADD-DUP.stderr`、`ACC-ADD-BADBROKER.stderr` |
| **G-39** | 状态转换 | `BUY-UNKNOWN-ACC` `BUY-UNKNOWN-SYM` `DIV-ADD-UNKNOWN-SYM` | 未登记的账户或标的 | 账户被自愈登记；未知标的被推断并在 symbols 落一行 | `BUY-UNKNOWN-ACC`: exit `0` · Δ `accounts`+1、`lots`+1、`trades`+1 <br>`BUY-UNKNOWN-SYM`: exit `0` · Δ `lots`+1、`symbols`+1、`trades`+1 <br>`DIV-ADD-UNKNOWN-SYM`: exit `0` · Δ `dividends`+1、`symbols`+1 <br>**pair_na**：规则文档没有给出必须被拒绝的未登记实体类别：账户侧 help 明确规定未登记账户按 CUSTOM 自愈，标的侧按代码推断。非法性由 G-38 / G-45 / G-22 覆盖，本守卫构造不出自己的违规输入。 | 违规侧：pair_na（无法构造违规输入，理由见实测摘要） | 合法侧：全部放行，未被误杀 | 本守卫的命题是「未登记实体自愈接受」，规则文档没有必须被拒绝的类别：违规侧 pair_na。 | `BUY-UNKNOWN-SYM.rows-after.txt`、`DIV-ADD-UNKNOWN-SYM.rows-after.txt` |
| **G-40** | 拦截 | `BUDGET-*` | 设置组合预算环境变量后按它换算占比 | 线上放行、越线拦截、跳过参数放行 | `BUDGET-BLOCK-OVER`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 单标的持仓硬顶风控拦截：买入后标的 600519.SH 估算持仓占比为 31.00%，超过 30.00% 组合级硬顶红线 (标的总额 3100.00 / 组合总值 10000.00)！ <br>`BUDGET-BLOCK-XL`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 单标的持仓硬顶风控拦截：买入后标的 000001.SZ 估算持仓占比为 75.00%，超过 30.00% 组合级硬顶红线 (标的总额 9000.00 / 组合总值 12000.00)！ <br>`BUDGET-PASS-EXACT`: exit `0` · Δ 建库 + 初始化 schema <br>`BUDGET-SKIP-RISK`: exit `0` · Δ `lots`+1、`trades`+1 <br>`BUDGET-BLOCK-OVER` ⇒ 「估算持仓占比为 31.00%」 | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝按预算换算越线（应拒绝）；合法侧＝线上与显式旁路（应放行并完成落库）。 | `BUDGET-PASS-EXACT.stdout`、`BUDGET-BLOCK-OVER.stderr` |
| **G-41** | 错误码映射 | `SERVE-PORT-CONFLICT-SECOND` | 目标端口已被占用 | 给出可读排查文案，禁止未捕获崩溃 | `SERVE-PORT-CONFLICT-SECOND`: exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 端口 18974 已被占用，本地引擎无法在 127.0.0.1:18974 启动。 <br>`SERVE-PORT-CONFLICT-HOLDER`: exit `0` · Δ **0**（各表前后相等） <br>`SERVE-PORT-CONFLICT-SECOND` ⇒ 「端口 18974 已被占用」 | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝端口已被占用的启动（应报错退出）；合法侧＝占用端口的占位会话（应放行并完成绑定与监听）。 | `SERVE-PORT-CONFLICT-AUDIT.txt`、`SERVE-PORT-CONFLICT-SECOND.stderr` |
| **G-42** | 安全门 | `SERVE-ENTROPY-1` `SERVE-ENTROPY-2` `SERVE-ENTROPY-3` | 连续多次自动生成会话凭据 | 每次都是高熵随机值、互不相同、仅当前用户可读写，且停机后被删除 | `SERVE-ENTROPY-1`: exit `0` · Δ **0**（各表前后相等） <br>`SERVE-ENTROPY-2`: exit `0` · Δ **0**（各表前后相等） <br>`SERVE-ENTROPY-3`: exit `0` · Δ **0**（各表前后相等） | 违规侧：无对应请求 | 合法侧：全部放行，未被误杀 | 违规侧＝低熵或重复凭据（应被判不合规）；合法侧＝每次自动生成的高熵凭据（应完成 0600 落盘并在停机时删除）。 | `SERVE-ENTROPY-1-AUDIT.txt`、`SERVE-ENTROPY-2-AUDIT.txt`、`SERVE-ENTROPY-3-AUDIT.txt`、`SERVE-TOKEN-ENTROPY-COUNT.txt` |
| **G-43** | 错误码映射 | `SERVE-JSON-READY` `SERVE-QUIET` `SERVE-START` | `--json` 与 `--quiet` 的输出契约 | `--quiet` 无启动横幅；`--json` 启动时一行 ready、停机追加一行 stopped | `SERVE-QUIET`: exit `0` · Δ **0**（各表前后相等） <br>`SERVE-JSON-READY`: exit `0` · Δ **0**（各表前后相等） <br>`SERVE-START`: exit `0` · Δ **0**（各表前后相等） | 违规侧：全部按预期处理（含标记/告警类） | 合法侧：全部放行，未被误杀 | 违规侧＝启用 `--quiet`/`--json` 的会话（应完成抑制与机器可读输出）；合法侧＝未使用 `--quiet` 的会话（应放行并照常打印横幅）。 | `SERVE-JSON-AND-QUIET-AUDIT.txt`、`SERVE-START.stdout` |
| **G-44** | 错误码映射 | `SCAN-BAD-JSON` `SCAN-BAD-THRESHOLD` | 阈值参数不是合法 JSON；或阈值取值类型非法 | 非法 JSON 拒绝；非法取值类型也必须拒绝而不能静默失效 | `SCAN-BAD-THRESHOLD`: exit `1` · Δ **0**（各表前后相等） · stdout: 「--thresholds['take_profit_min'] 必须是有限数值，收到: "high"」 <br>`SCAN-BAD-JSON`: exit `1` · Δ **0**（各表前后相等） · stdout: 「--thresholds 不是合法 JSON: not-json」 <br>`SCAN-THR-OVERRIDE`: exit `0` · Δ `signals`+1 <br>`SCAN-THR-DEFAULT`: exit `0` · Δ **0**（各表前后相等） <br>L5 复核（`E2E-N-88`）: 非法 JSON 与非法取值类型两次均 exit `1` · Δ 0 | 违规侧：全部拦截/拒绝成功（非法 JSON 与非法取值类型均 exit 1 · Δ 0，D-07 已修复） | 合法侧：全部放行，未被误杀 | 违规侧＝非法 JSON 与非法取值类型（应拒绝）；合法侧＝合法阈值与默认阈值（应放行且不误报）。 | `SCAN-BAD-THRESHOLD.stdout`、`SCAN-BAD-JSON.stderr`、`SCAN-THR-OVERRIDE.stdout` |
| **G-45** | 拦截 | `PRICE-GUARD-ILLEGAL` `PRICE-GUARD-LEGAL` `BUY-PRICE-NAN` | 价格不是有限正数（非数值、零、负数） | 拒绝建仓且不落库；合法价格正常放行 | `PRICE-GUARD-ILLEGAL`: exit `1` · Δ **0**（各表前后相等） · stdout: 「非法成交价：--price 必须是合法数值字面量…，收到: abc」 <br>`BUY-PRICE-NAN`: exit `1` · Δ **0**（各表前后相等） · 同上（非数值字面量） <br>`BUY-PRICE-ZERO`: exit `1` · Δ **0**（各表前后相等） · stdout: 「非法成交价：--price 必须为有限正数（> 0），收到: 0」 <br>`BUY-PRICE-NEG`: exit `1` · Δ **0**（各表前后相等） · stdout: 「非法成交价：--price 必须为有限正数（> 0），收到: -2.5」 <br>`PRICE-GUARD-LEGAL`: exit `0` · Δ `lots`+1、`trades`+1 <br>`BUY-OK-FLAGS`: exit `0` · Δ `lots`+1、`trades`+1 <br>L5 复核（`E2E-N-90`）: `--price abc / 0 / -2.5` 三次均 exit `1` · 六表 Δ 0 · `库内非法价格行数 bad_rows=0`（NaN 污染路径已随 D-09 修复消失） | 违规侧：全部拦截/拒绝成功（非有限正数价格一律 exit 1 · Δ 0，D-09 已修复） | 合法侧：全部放行，未被误杀 | 违规侧＝非有限正数价格（应拒绝且不落库）；合法侧＝合法价格（应放行并完成落库）。 | `PRICE-GUARD-AUDIT-CORRECTION.txt`、`NAN-RAW-ROWS.txt`、`NAN-CONTAMINATION-AUDIT.txt` |
| **G-46** | 拦截 | `FEE-GUARD-ILLEGAL` `QTY-GUARD-ILLEGAL` `STATS-DAYS-BAD` | **非价格类**数值旗标（`--fee` / `--qty` / `--days` 等）取非法字面量（非数值、千分位逗号、单位后缀、下划线、十六进制） | 字面量层统一拒绝：exit≠0 · 零写入 · 文案指明该旗标；等价合法写法（`0` / `5.5` / `1e3` / `7.0` / `100`）一律放行 | `FEE-GUARD-ILLEGAL`: exit `1` · Δ **0**（各表前后相等） · stdout: 「--fee 必须是合法数值字面量（禁止千分位逗号 / 单位后缀 / 下划线 / 十六进制），收到: abc」 <br>`QTY-GUARD-ILLEGAL`: exit `1` · Δ **0**（各表前后相等） · stdout: 「--qty 必须是合法数值字面量…，收到: abc」 <br>`STATS-DAYS-BAD`: exit `1` · Δ **0**（各表前后相等） · stdout: 「--days 必须是合法数值字面量…，收到: abc」 <br>`FEE-GUARD-LEGAL`（`--fee 0` / `--fee 5.5`）: exit `0` · Δ `lots`+1 · `cost_basis_unit` 有限正数（`--fee 5.5` 时 = price + fee/qty = 8.254） <br>`QTY-GUARD-LEGAL`（`--qty 100`）: exit `0` · Δ `lots`+1 <br>L5 复核：`E2E-N-100`（violation，exit 1 · Δ 0）/ `E2E-P-19`（legal，exit 0 · lots+1） | 违规侧：全部拦截/拒绝成功 | 合法侧：全部放行，未被误杀 | 违规侧＝非法字面量（应拒绝）；合法侧＝等价合法写法（应放行且数值正确换算） |  L5 证据 `E2E-N-100.json` / `E2E-P-19.json` |

---

## 12. 来源映射表

未映射条目数 = **0**。`safety-checklist` 的 6 大节与其下 16 条 bullet 分两层列出，任一读法都无遗漏。

### 12.1 `docs/qa/safety-checklist.md`

| 来源条目 | 落点 G-xx | 说明 |
|---|---|---|
| §1 账本物理隔离守卫（整节） | G-01 G-02 G-03 | 由 §1.1/§1.2/§1.3 三条覆盖 |
| §2 本地回环与账本私密性守卫（整节） | G-04 G-41 G-12 | 由 §2.1/§2.2/§2.3 三条覆盖 |
| §3 会话凭据门禁（整节） | G-05 G-42 G-06 G-07 | 由 §3.1~§3.4 四条覆盖 |
| §4 组合风控与仓位硬顶守卫（整节） | G-15 G-16 G-17 G-18 G-40 | 由 §4.1/§4.2 两条覆盖 |
| §5 批次生命周期与异常状态守卫（整节） | G-29 | 由 §5.1/§5.2 两条覆盖 |
| §6 金字塔加仓防抖守卫（整节） | G-19 G-20 G-21 | 由 §6.1/§6.2 两条覆盖；§6.1 存在 D-01 绕过口 |
| §1.1 生产账本防触碰 | G-01 G-03 | 命令全部带沙箱 `--db`；缺 `--db` 的默认回退改为 BLOCKED 而非绕过 |
| §1.2 环境变量/参数重定向 | G-02 | 采集器注入三个环境变量与沙箱 HOME，并实测 `--db` 覆盖 |
| §1.3 清理与防残留 | G-01 | 收工删除沙箱数据，见 §15.4 的显式保留声明 |
| §2.1 127.0.0.1 严格绑定 | G-04 | 三类非回环地址全部拒绝，回环别名实测绑定范围 |
| §2.2 端口冲突优雅提示 | G-41 | 可读排查文案、零堆栈 |
| §2.3 优雅关机 | G-12 | SIGTERM 与 SIGINT 各验一次 |
| §3.1 0600 凭证文件权限 | G-05 | 沙箱与 HOME 重定向两路 |
| §3.2 随机性（高熵令牌） | G-42 | 三次样本长度与字符集正确且互不相同 |
| §3.3 401 未授权拦截 | G-06 | 缺失 / 错误 / 查询串错误三类 |
| §3.4 账本零泄漏 | G-07 | 对全部未授权响应体做敏感词扫描，命中 NONE |
| §4.1 单标的仓位硬顶 | G-15 G-16 G-17 | 含恰好落在线上与刚越线两个边界 |
| §4.2 预算不可突破 | G-40 | 用组合预算环境变量实测 |
| §5.1 大跌严禁冻结 | G-29 | 保持活跃并允许平仓 |
| §5.2 极度深跌预警 | G-29 | 告警 payload 显式声明未冻结 |
| §6.1 48 小时冷却拦截 | G-19 G-21 | 拦截成立，但可被未来成交时间绕过 |
| §6.2 加仓层级递增 | G-20 | 父子链路与层级递增 |

### 12.2 `docs/qa/acceptance-cases.md`

| 来源条目 | 落点 G-xx | 说明 |
|---|---|---|
| TC-P01 账户注册与列表查询 | G-38 | 接口断言口径不同但等价：本线用行数差替代 JSON 字段名 |
| TC-P02 独立批次建仓买入 | G-22 G-45 | 参数按 help 事实改写为 flag 形式；断言成功建仓且全成本单价可核 |
| TC-P03 跨 48 小时正常阶梯加仓 | G-20 | 用例给的层级与股数数字与实现口径不符，见草案差异 D-07 |
| TC-P04 动态移动止盈触发与平仓 | G-30 G-31 G-29 | 触发面已实测；用例给的具体收益数字未按该值复核 |
| TC-N01 合法入参防误杀断言 | G-22 G-15 G-16 G-45 | 合法价格、整百股数、线内占比这三类输入的期望都是「放行、不拦截」（结论由推导给出） |
| TC-N02 冷却期内高频加仓拦截 | G-19 | 退出码、文案关键词、批次数三条同时成立 |
| TC-N03 冷却期外正常加仓放行 | G-20 | 放行且层级递增 |
| TC-N04 浮盈未达标不误触移动止盈 | G-31 | 低于激活线不激活；另用峰值注入覆盖已激活但回撤不足。**本轮更正**：上一版误挂 G-45（价格守卫），与移动止盈无关 |
| TC-N05 高位回撤未达标不误报 | G-31 | 回撤低于阈值时告警计数为零 |
| TC-N06 跌幅超阈值严禁冻结批次 | G-29 | 保持活跃、发告警、平仓成功 |
| TC-N07 单标的仓位硬顶拦截 | G-15 G-16 | 参数按沙箱改写，断言拦截与超限提示 |
| TC-N08 跨券商账户日内代冲隔离 | G-26 | 跨账户被拒；扫描侧同口径命中 T+1 锁定 |
| TC-N09 未授权请求严禁泄露账本数据 | G-06 G-07 | 端口按沙箱约束改写；敏感词扫描为零命中 |

### 12.3 中枢草案 阶段 3（负向守卫）第 1~9 条

| 草案条目 | 落点 G-xx | 说明 |
|---|---|---|
| 3.1 合法价格/整百股数/合法代码建仓成功 | G-22 G-45 | 成立；另发现非数值价格未被拦截（D-09） |
| 3.2 冷却期内拦截 + 冷却期外放行 | G-19 G-20 | 两项均成立 |
| 3.3 未达阈值不激活移动止盈；回撤不足不误报 | G-31 | 用低于激活线的收益率与低于阈值的回撤等价覆盖 |
| 3.4 深跌保持活跃、发告警、仍可平仓 | G-29 | 平仓已实测；「仍可加仓」未实测，留给 L2 |
| 3.5 仓位硬顶拦截 + 线内放行 | G-15 G-16 | 本线做到线上放行与刚越线拦截两个边界 |
| 3.6 跨账户代冲隔离 | G-26 | 拦截成立；拦截文案与草案给的字面量不同源 |
| 3.7 无/错凭据返回未授权且不泄露 | G-06 G-07 | 成立 |
| 3.8 伪造主机头与非法来源被拒 | G-08 G-09 | 成立，非法来源响应不含跨域放行头 |
| 3.9 降级探测 | G-14 | 空库不降级、异常账本报降级，两路都实测 |

---

## 13. 草案差异

> 草案原文：`reports/tp-5a3bfad8-hub-draft-ops-and-e2e.md`。只列事实差异，不改判草案意图。

| # | 草案原文 | 实测事实 | 证据 |
|---|---|---|---|
| **D-1** | 「全量子命令均支持 `--json`」 | 父级汇总命令本身不声明 `--json`，只有叶子动作声明 | `HELP-lot.stdout` |
| **D-2** | `lot add --parent-lot-id` / `lot edit` 的参数表 | 父批次参数另有别名，`lot buy`/`lot close` 另有费用与时间参数，`lot buy`/`lot add` 另有跳过风控参数，`lot edit` 另有买入理由别名 | `HELP-lot-add.stdout` |
| **D-3** | `dividend add` 的 `--record-date` / `--ex-date` / `--reason` | 产品不存在这些参数；help 实际列出的入参是 `--symbol` / `--amount` / `--date` / `--account` / `--shares` / `--per-share` / `--notes`。草案参数被静默忽略（缺陷 D-03） | `HELP-dividend-add.stdout`、`DIV-ADD-DRAFTFLAG.stdout` |
| **D-4** | 「`--token` 指定时停机不误删外部令牌」 | 不删除成立，但不覆写不成立：既有凭据文件的内容被显式口令覆写 | `SERVE-EXTERNAL-TOKEN-AUDIT.txt` |
| **D-5** | dashboard / serve 的参数表 | 两者都有凭据文件参数，serve 另有静默参数；`--json` 在停机时会追加第二行 | `HELP-serve.stdout`、`SERVE-JSON-AND-QUIET-AUDIT.txt` |
| **D-6** | 草案未提别名 | physics 的 usage 行标注别名，且别名可派发、输出一致 | `HELP-radar-alias.stdout` |
| **D-7** | 阶段 2.3「层级=2、股数按默认金额取整」 | 层级从零起算，第一个子批次是子层级一；股数由金额与价格反算，且金额可被参数覆盖 | `ADD-AMOUNT-DEFAULT.stdout`、`ADD-QTY-EXPLICIT.stdout` |
| **D-8** | 阶段 3.3 的两个收益率端点 | 用区间内单点覆盖，未逐字复现草案给的两个端点值 | `SCAN-THR-DEFAULT.stdout` |
| **D-9** | 阶段 4.1 三项产物属性 | 三项都成立；但草案未提页面把探活地址写死（缺陷 D-08） | `DASH-ARTIFACT-FORENSICS.txt` |
| **D-10** | 阶段 4.2「零未捕获异常」 | 输出目录不存在时抛出解释器 traceback（缺陷 D-04） | `DASH-OUT-BADDIR.stderr` |
| **D-11** | 「16 个核心测试套件」 | 本线不跑 `bun test`，不下结论；数量判定留给单测映射线 | 不适用（本线不产出该证据） |
| **D-12** | 阶段 1.3「验证 `--db` 覆盖环境变量」 | 成立；同级的其余环境变量优先级需无 `--db` 调用，本线 BLOCKED | `G-DB-OVER-ENV.stdout`、`G-ENV-LOTDB-WINS.stdout` |
| **D-13** | 阶段 3.5 的 30% 口径 | 口径是「新增标的估值 ÷（其他标的 + 新增标的）」，是跨标的组合窗口，不是单标的绝对金额上限 | `RISKSAME-HUGE.stdout` |
| **D-14** | 9 大模块一览 | 另有草案未列的输入面：成交时间可回填并改变批次 ID 的日期前缀；未知子动作回落 help 且退出码与根级未知子命令不一致 | `BUY-WITH-TIME.stdout`、`HELP-lot-bogus.exit` |
| **D-15** | 阶段 2.6「分红冲减摊薄成本」 | 不成立：登记分红前后持仓成本字段逐字节相同，产品把分红作为累计现金汇总 | `DIV-COST-EFFECT-ASSERT.txt` |

---

## 14. 缺陷 / BLOCKED

### 14.1 产品缺陷（复现命令与前后数值均取自证据原文）

#### D-01（P1）48 小时同源防抖守卫可被未来成交时间绕过

复现命令（取自 `ADD-TIME-FORGERY.cmd`）：

```
./trade lot add --parent-lot-id LOT-20261019-001 --price 2.250 --account ACCA --skip-risk --time '2026-10-24T15:21:26Z' --reason 'forged_future' --db /tmp/qa-tp5a3bfad8-L1r2-20261022-222110/db/add.db
```

| 观测点 | 证据原文摘录 |
|---|---|
| `ADD-TIME-FORGERY` | exit `0` · Δ `lots`+1、`trades`+1 |
| `ADD-COOLDOWN-BLOCK` | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 加仓失败: 加仓防抖冷却窗口守卫拦截：同源血缘链批次 LOT-20261022-001 (L1) 于 2026-10-22T14:21:28.028Z 已执行加仓，尚在 48 小时 (2 个交易日) 防抖冷却窗口内 (剩余 48.0 小 |
| `ADD-FORGED-INVISIBLE` | exit `0` · Δ `lots`+1、`trades`+1 |
| `ADD-TIME-FORGERY` 摘录 | 「批次ID: LOT-20261024-001」 |
| `ADD-FORGED-INVISIBLE` 摘录 | 「批次ID: LOT-20261031-001」 |

冷却判断把**传入的成交时间**当作当前时钟。先在真实时间轴上被正确拦截的同一血缘链，只要把本次加仓的时间写成未来值即可放行；更远一些的未来值同样放行。产品也未对该时间做「不得晚于现在」的校验。

证据：`ADD-TIME-FORGERY.stdout`、`ADD-FORGED-INVISIBLE.stdout`、`ADD-COOLDOWN-BLOCK.stderr`

**修复状态（`line/tp-458199de-L1`）：已修复。** `src/engine.ts` 的 48h 冷却判定改用**真实时钟**（`checkLineageAntiShake(parentLotId, realNow)`），并且新增「成交时间不得晚于当前」守卫：`--time` 晚于当前时钟、或无法解析为有效时间戳，一律 exit≠0 且零写入（买/加/平三个入口同一条守卫）。原 `ADD-TIME-FORGERY` 复现命令现在 exit `1`、六表行数不变，文案为「成交时间不得晚于当前时间：加仓成交时间 传入 … 晚于当前 …，已拒绝写入账本」。合法回填（过去时间、窗口外）仍然放行。

#### D-02（P2）`scan --help` 给出的阈值示例键与实现不一致，照抄即失效

复现命令（取自 `SCAN-MENU-KEYS.cmd`）：

```
./trade scan --json --thresholds '{"add":-0.1,"take":0.1}' --db /tmp/qa-tp5a3bfad8-L1r2-20261022-222110/db/scan-thr.db
```

| 观测点 | 证据原文摘录 |
|---|---|
| `SCAN-MENU-KEYS` | exit `0` · Δ **0**（各表前后相等） |
| `SCAN-THR-OVERRIDE` | exit `0` · Δ `signals`+1 |
| `SCAN-THR-DEFAULT` | exit `0` · Δ **0**（各表前后相等） |
| `SCAN-THR-OVERRIDE` 摘录 | 「"trigger_return_rate": 0.0696」 |

用实现真正读取的键能立刻把同一批次从零信号变成止盈信号；直接照抄 help 里的示例键则仍然零信号，说明示例键不被实现读取。

证据：`SCAN-MENU-KEYS.stdout`、`SCAN-THR-OVERRIDE.stdout`、`HELP-scan.stdout`

**修复状态（`c895274`，L5 复核）：已修复。** `trade scan --help` 改为按实现真正读取的键逐条列出（`take_profit_min` / `trailing_activate` / `trailing_pullback` / `dip_1` / `deep_value`），示例改为 `{"take_profit_min":0.05,"dip_1":-0.08}`。配合 D-07 的键名/类型校验：照抄该示例 exit `0` 且把 +10% 批次从零信号变为 `TAKE_PROFIT_ALERT`；D-02 修复前的旧键 `{"add":-0.1,"take":0.1}` 现在 exit `1`（「--thresholds 含未知键 'add'；支持: take_profit_min, trailing_activate, trailing_pullback, dip_1, deep_value」）。L5 `E2E-N-65` PASS。

#### D-03（P2）未知参数被静默忽略：分红除息日被悄悄写成默认值

复现命令（取自 `DIV-ADD-DRAFTFLAG.cmd`）：

```
./trade dividend add --symbol 518880.SH --amount 1.00 --ex-date 2026-01-01 --record-date 2026-01-02 --db /tmp/qa-tp5a3bfad8-L1r2-20261022-222110/db/div-neg.db
```

| 观测点 | 证据原文摘录 |
|---|---|
| `DIV-ADD-DRAFTFLAG` | exit `0` · Δ `dividends`+1 |
| `DIV-LIST-NEG` | exit `0` · Δ **0**（各表前后相等） |
| `DIV-ADD-DRAFTFLAG` 摘录 | 「DIV-20261022222147-7MES」 |
| `DIV-LIST-NEG` 摘录 | 「DIV-20261022222147-7MES」 |
| `DIV-LIST-NEG` 摘录 | 「DIV-20261022222146-WVT0」 |
| `DIV-LIST-NEG` 摘录 | 「2026-10-22」 |
| `DIV-LIST-NEG` 摘录 | 「2026-10-22」 |

命令行里给出的除息日参数在产品中并不存在，命令既不报错也不提示，落库时除息日取默认值。**对账出处**：该记录落在 `div-neg.db` 上（同目录的 `DIV-ADD-DRAFTFLAG.cmd` 与 `DIV-LIST-NEG.cmd` 可证），因此对账读的是 `DIV-LIST-NEG.stdout`，不是跑在 main.db 上的 `DIV-LIST.stdout`。除息日直接影响分红归属期，属会计相邻字段的数据正确性风险。

证据：`DIV-ADD-DRAFTFLAG.stdout`、`DIV-LIST-NEG.stdout`

**修复状态（`c895274`，L5 复核）：已修复。** 未声明参数一律 exit≠0 且零写入，文案为「未声明的参数 <flag>（命令: trade <cmd>）。运行 'trade <cmd> --help' 查看支持的参数。」（`E2E-N-92`：`dividend add --ex-date` exit `1`、`dividends` 保持 0 行）。**连带效应需登记**：`lot buy` 的建仓理由旗标是 `--reason`，`--buy-reason` 只属于 `lot edit`；D-03 生效后把 `--buy-reason` 传给 `lot buy` 会被判未声明参数并拒（exit `1` · Δ 0）。旧 E2E 用例 `E2E-N-55/56` 正是靠「静默忽略」才通过的（当时断言 `before=` 为空串、行快照里 `buy_reason` 为空），判据已按 help 更正为 `--reason`，两条用例现 PASS。

#### D-04（P3）`dashboard --out` 指向不存在的目录时喷出解释器 traceback

复现命令（取自 `DASH-OUT-BADDIR.cmd`）：

```
./trade dashboard --out /tmp/qa-tp5a3bfad8-L1r2-20261022-222110/nope-dir/x.html --token-file /tmp/qa-tp5a3bfad8-L1r2-20261022-222110/fakehome/.lot-trader/absent.token --db /tmp/qa-tp5a3bfad8-L1r2-20261022-222110/db/dash.db
```

| 观测点 | 证据原文摘录 |
|---|---|
| `DASH-OUT-BADDIR` | exit `1` · Δ **0**（各表前后相等） · stderr: Traceback (most recent call last): |

退出码与最终错误文案都正确，但 stderr 里先输出未捕获异常的完整堆栈，再补一句友好错误，与「零未捕获异常」的口径冲突。

证据：`DASH-OUT-BADDIR.stderr`

**修复状态（`c895274`，L5 复核）：已修复。** `dashboard --out <不存在的目录>/x.html` 现在 exit `1` 且 stderr 无解释器堆栈（`E2E-N-93`：`不得抛出未捕获堆栈 matched=false`、六表 Δ 0），错误文案为可读的「输出目录不存在」类提示。

#### D-05（P2）`stats --days` 取非数值时静默把报表清空

复现命令（取自 `STATS-DAYS-BAD.cmd`）：

```
./trade stats --days abc --db /tmp/qa-tp5a3bfad8-L1r2-20261022-222110/db/main.db
```

| 观测点 | 证据原文摘录 |
|---|---|
| `STATS-DAYS-BAD` | exit `0` · Δ **0**（各表前后相等） |
| `STATS-DEFAULT` | exit `0` · Δ **0**（各表前后相等） |
| `STATS-DEFAULT` 摘录 | 「总平仓笔数:      6 笔」 |

非法天数不报错、不改文案，只把结果清空成零笔。操盘者看到零笔会误判为没有成交，而不是参数写错。

证据：`STATS-DAYS-BAD.stdout`、`STATS-DEFAULT.stdout`

**修复状态（`c895274`，L5 复核）：已修复。** `stats --days abc` 现在 exit `1`（「--days 必须是合法数值字面量（禁止千分位逗号 / 单位后缀 / 下划线 / 十六进制），收到: abc」）且报表保持原样（默认窗口 `total_trades=1` → 非法调用后仍 1 笔，不再静默清空）；等价的合法写法仍放行：`--days 7.0` exit `0`、`--days 1e3` exit `0`。L5 `E2E-N-94` PASS。

#### D-06（P3）仓位硬顶拦截文案把比例四舍五入后与阈值并列，读起来自相矛盾

复现命令（取自 `RKO-OVER-30PCT.cmd`）：

```
./trade lot buy --symbol 159915.SZ --price 3.0005 --qty 1000 --account ACCA --db /tmp/qa-tp5a3bfad8-L1r2-20261022-222110/db/risk-over.db
```

| 观测点 | 证据原文摘录 |
|---|---|
| `RKO-OVER-30PCT` | exit `1` · Δ **0**（各表前后相等） · stderr: ❌ 建仓失败: 单标的持仓硬顶风控拦截：买入后标的 159915.SZ 估算持仓占比为 30.00%，超过 30.00% 组合级硬顶红线 (标的总额 3000.50 / 组合总值 10000.50)！ |
| `RKO-OVER-30PCT` 摘录 | 「估算持仓占比为 30.00%」 |

拦截判定本身正确，但展示值经过四舍五入后与阈值相同，于是出现「与阈值相同却超过阈值」的表述。

证据：`RKO-OVER-30PCT.stderr`

**修复状态（`line/tp-458199de-L1`）：已修复。** 拦截判定与零写入行为未变，只把文案里的占比精度从 2 位小数提高到 4 位小数（`30.0035%`），阈值仍写 `30.00%`，两者不再同值。同一复现命令现在 stderr 为「…估算持仓占比为 30.0035%，超过 30.00% 组合级硬顶红线 (标的总额 3000.50 / 组合总值 10000.50)！」，exit `1`、六表行数不变。

#### D-07（P2）`scan --thresholds` 取值不做类型与键名校验，一个笔误即可静默关闭止盈提醒

复现命令（取自 `SCAN-BAD-THRESHOLD.cmd`）：

```
./trade scan --json --thresholds '{"take_profit_min":"high"}' --db /tmp/qa-tp5a3bfad8-L1r2-20261022-222110/db/scan-thr.db
```

| 观测点 | 证据原文摘录 |
|---|---|
| `SCAN-BAD-THRESHOLD` | exit `0` · Δ **0**（各表前后相等） |
| `SCAN-THR-OVERRIDE` | exit `0` · Δ `signals`+1 |

阈值取值为字符串时既不报错也不校验，直接参与数值比较，结果永远是「不满足」，于是止盈告警被静默关掉；与 D-02 叠加后，键对值错同样无声。

证据：`SCAN-BAD-THRESHOLD.stdout`、`SCAN-THR-OVERRIDE.stdout`

**修复状态（`c895274`，L5 复核）：已修复。** 阈值键名与取值类型统一校验：`{"take_profit_min":"high"}` → exit `1`「--thresholds['take_profit_min'] 必须是有限数值，收到: "high"」；未知键 → exit `1`「--thresholds 含未知键 'add'；支持: take_profit_min, trailing_activate, trailing_pullback, dip_1, deep_value」；非法 JSON → exit `1`「--thresholds 不是合法 JSON: not-json」。三次均零写入（`E2E-N-88`）；合法覆盖照常生效（`E2E-N-89`）。

#### D-08（P2）看板把本地引擎探活地址写死，生成器没有端口或基址覆盖参数

| 观测点 | 证据原文摘录 |
|---|---|
| `DASH-OUT-NONE` | exit `0` · Δ **0**（各表前后相等） |
| `SERVE-8080-LINKED` | exit `BLOCKED` · Δ — |

生成的页面把引擎探活地址固定为一个特定端口，生成器也没有任何覆盖参数，因此引擎起在其他端口时页面永远停在独立模式且不报错；本话题的端口边界又禁止使用该固定端口，联动模式因此无法在本线验证。

证据：`DASH-ARTIFACT-FORENSICS.txt`、`SERVE-8080-LINKED.stdout`

**修复状态（`c895274`，L5 复核）：已修复。** 新增 `trade dashboard --api-base <url>`（help：「Probe base the page heartbeats against (default: http://127.0.0.1:8080). Pass the address `trade serve` is actually listening on …」），产物的探活基址绑定改为 `LOCAL_API_BASE = '<传入值>'`，不再写死 8080。L5 双模验证（全程在 18000–18999 端口内，未碰 8080）：`trade serve`（18186）+ `--api-base http://127.0.0.1:18186` 生成看板 → headless Chrome 读 DOM 得 `class="mode-indicator local"` + 文案「模式：本地引擎已联动」+ `live-status`「本地引擎行情 …」，DOM 139,705 字符、NaN 命中 0；`SIGTERM` 停机（exit `0`、端口释放）后重载同一页面 → `class="mode-indicator standalone"` +「轻量独立（纯前端自驱）」，DOM 139,673 字符、NaN 命中 0。对应用例 `E2E-N-96` / `E2E-N-97` 由 BLOCKED 转 **PASS**，§14.3 的 `SERVE-8080-LINKED` / `SERVE-DUAL-MODE-GREENLIGHT` 两条 BLOCKED 随之解除。

#### D-09（P1）价格缺少「有限正数」校验：非数值、零、负数都被接受并写入账本

复现命令（取自 `BUY-PRICE-NAN.cmd`）：

```
./trade lot buy --symbol 518880.SH --price abc --qty 100 --account NACC --reason 'nan_case' --db /tmp/qa-tp5a3bfad8-L1r2-20261022-222110/db/nan.db
```

| 观测点 | 证据原文摘录 |
|---|---|
| `BUY-PRICE-NAN` | exit `0` · Δ `lots`+1、`trades`+1 |
| `BUY-PRICE-ZERO` | exit `0` · Δ `lots`+1、`trades`+1 |
| `BUY-PRICE-NEG` | exit `0` · Δ `lots`+1、`trades`+1 |
| `PRICE-GUARD-ILLEGAL` | exit `0` · Δ `lots`+1、`trades`+1 |
| `PRICE-GUARD-LEGAL` | exit `0` · Δ `lots`+1、`trades`+1 |
| `NAN-POLLUTION-POS` | exit `0` · Δ **0**（各表前后相等） |
| `NAN-POLLUTION-LIST` | exit `0` · Δ **0**（各表前后相等） |
| `NAN-POLLUTION-STATS` | exit `0` · Δ **0**（各表前后相等） |
| `NAN-POLLUTION-SCAN` | exit `0` · Δ **0**（各表前后相等） |
| `BUY-PRICE-NAN` 摘录 | 「LOT-20261022-001」 |
| `BUY-PRICE-NAN` 摘录 | 「成交单价: NaN 元」 |
| `BUY-PRICE-NAN` 摘录 | 「全成本单价: NaN 元」 |
| `NAN-POLLUTION-POS` 摘录 | 「"total_cost": null」 |
| `NAN-POLLUTION-LIST` 摘录 | 「"buy_price": null」 |

价格解析后没有任何有限性校验就进入落库路径，三种非法取值全部被接受：非数值写成 NaN、零价写成零、负价连规费一起写成负数。非数值批次还会污染派生视图——组合总览的成本与浮盈、批次列表的价格被序列化成空值。同一库上的报表与扫描因为不涉及该字段而没有变化。**第 1 轮把零价与负价误判为「已被拦截」**：那一轮它们与大量其他批次共用同一个库，被 30% 仓位硬顶挡下，退出码非零掩盖了价格校验的缺失；本轮把校验类用例放进独立库后才暴露出来。

证据：`NAN-RAW-ROWS.txt`、`NAN-CONTAMINATION-AUDIT.txt`、`PRICE-GUARD-AUDIT-CORRECTION.txt`、`BUY-PRICE-NAN.stdout`

**修复状态（`line/tp-458199de-L1`）：已修复。** `src/engine.ts` 新增 `assertLegalFillPrice()`，`lot buy` / `lot add` / `lot close` 三个写库入口在**任何落库动作之前**（早于账户自愈与 INSERT）断言价格为有限正数：NaN / ±Infinity / 0 / 负数一律 exit≠0 且零写入，文案含「非法成交价」。非数值批次的 `total_cost: null` / `buy_price: null` 污染路径随之消失；`lot add` 的价格断言还提前到 `amount / price` 换算之前，避免先算出 Infinity/NaN 股数。合法价格未被误杀（`2.0001`、`8.199`、`6.120` 均 exit 0 且 `--fee 0` 时 `cost_basis_unit` 等于成交价）。

#### D-10（P2）非价格类数值旗标（`--fee` / `--qty` / `--days`）的字面量守卫原本**无用例覆盖**（守卫已随 round-4 字面量层落地，L5 补齐成对用例）

复现（L5 核验命令，沙箱库）：

```
./trade lot buy 518880.SH --price 8.199 --qty 100 --account ACC --fee abc --skip-risk --json --db /tmp/…/db/p.db
./trade lot buy 518880.SH --price 8.199 --qty abc --account ACC --fee 0 --skip-risk --json --db /tmp/…/db/p.db
./trade stats --days abc --json --db /tmp/…/db/p.db
```

| 观测点 | L5 实测原文摘录 |
|---|---|
| `--fee abc` | exit `1` · Δ **0**（各表前后相等） · stdout: 「--fee 必须是合法数值字面量（禁止千分位逗号 / 单位后缀 / 下划线 / 十六进制），收到: abc」 |
| `--qty abc` | exit `1` · Δ **0**（各表前后相等） · stdout: 「--qty 必须是合法数值字面量…，收到: abc」 |
| `--days abc` | exit `1` · Δ **0**（各表前后相等） · stdout: 「--days 必须是合法数值字面量…，收到: abc」 |
| `--fee 0` / `--fee 5.5` / `--qty 100` | exit `0` · Δ `lots`+1 · `cost_basis_unit` 有限正数（`--fee 5.5` → `8.254` = price + fee/qty） |
| `--days 7.0` / `--days 1e3` | exit `0`（等价合法写法不被误杀） |

缺陷定性（避免与「已观测到错误写入」混同）：本条**不来自线上错误观测**，而是 L5 门禁核验时对「字面量层数值契约是否覆盖**全部**数值旗标」做的用例覆盖审计——当时 `--price` 有 `G-45` 成对用例，`--fee` / `--qty` / `--days` **没有任何用例**，属「守卫无回归保护」的覆盖缺口；补测时确认守卫本身已随 round-4 字面量层落地（故**修复前无错误写入可引**，引用不了就不引）。

**修复状态（`c895274`，L5 复核）：已修复（守卫已在；用例已补齐）。** 对应新增成对用例 `E2E-N-100`（violation）+ `E2E-P-19`（legal）均 PASS；守卫登记为 §11 `G-46`。

证据：`E2E-N-100.json`、`E2E-P-19.json`（L5 证据目录 `docs/qa/evidence/tp-5a3bfad8-L2-20261026-103214-commit-c895274f/`）

### 14.2 非阻塞观测（输入校验一致性缺口，未升级为缺陷）

| # | 观测 | 期望来源 | 证据 |
|---|---|---|---|
| V-01 | 未知参数与未知子动作的处置已部分收敛（D-03）：已知子命令上的**未声明参数**一律 exit≠0 且零写入；**未知子动作**回落父级 help 但退出码已改为非 0（实测 `trade lot bogus` → exit `1`）；裸位置参数（`trade lot list extra` / `trade account add … extra`）仍被静默忽略、exit `0`；根级未知参数 exit `1` | §0 分类规则 | `ACC-LIST-FILTER.stdout`、`HELP-lot-bogus.exit` |
| V-02 | 批次列表的状态枚举不做校验：非法值与大小写错误都静默返回空列表 | §0 分类规则 | `LIST-STATUS-BAD.stdout`、`LIST-STATUS-LOWER.stdout` |
| V-03 | 标的名归一化会静默截断笔误代码，并写入 symbols 表 | §0 分类规则 | `DIV-ADD-UNKNOWN-SYM.stdout`、`DIV-ADD-UNKNOWN-SYM.rows-after.txt` |
| V-04 | 负数金额不校验，静默回落默认金额基准 | §0 分类规则 | `ADD-AMOUNT-NEG.stdout` |
| V-05 | 标的存在性不校验：物理雷达与持仓视图对未知代码都返回成功 | §0 分类规则 | `PHY-BAD-SYMBOL.stdout`、`POS-BAD-SYMBOL.stdout` |
| V-06 | 鉴权门先于路由：无凭据者无法区分端点是否存在 | help | `SERVE-UNKNOWN-ENDPOINT.status`、`SERVE-UNKNOWN-ENDPOINT-AUTH.status` |
| V-07 | IPv6 字面量 URL 未加方括号，公告的地址不可直接使用 | help | `SERVE-BIND-IPV6LOOP.stdout` |
| V-08 | 账户 ID 不做大小写归一，与建仓侧的账户归一逻辑口径可能不一致 | §0 分类规则 | `ACC-ADD-LOWERID.stdout` |
| V-09 | `--json` 是多行格式化 JSON 而非 JSONL；serve 的 `--json` 则在停机时追加第二行 | help | `SCAN-TP-RUN.stdout`、`SERVE-JSON-AND-QUIET-AUDIT.txt` |
| V-10 | 父级 help 未裁剪：账户子动作与雷达别名都逐字节复用父级输出 | help | `HELP-account-add.stdout`、`HELP-radar-alias.stdout` |
| V-11 | `--db` 指向不存在的目录会自动建目录建库，这正是 checker 必须断言 `--help` 不建库的原因 | §0 分类规则 | `G-DB-BAD-PARENT.rows-after.txt` |
| V-12 | `account list --all` 与不带该参数输出逐字节相同，该分支未被真正覆盖 | help | `ACC-LIST.stdout`、`ACC-LIST-ALL.stdout` |
| V-13 | 未知子动作与未知全局参数都以成功/失败两种不同退出码回落 help，退出码语义不统一 | §0 分类规则 | `HELP-lot-bogus.exit`、`G-UNKNOWN-SUB.exit` |

### 14.3 BLOCKED 清单（缺什么能力）

| OP-ID | 缺失能力 / 阻塞原因 |
|---|---|
| `G-ENV-LOTDB-WINS` | 需要一次**不带 `--db`** 的调用才能观测环境变量之间的优先级，与本话题隔离规则冲突；建议 L2 在 HOME 与三个环境变量全部重定向到沙箱后单独授权一次。 |
| `G-ENV-TRADEDB-FALLBACK` | 同上（还需同时不设 `LOT_TRADER_DB`）。 |
| `G-DEFAULT-DB-PATH` | 该级回退会解析到生产账本，本话题明令禁止读写，拒绝执行。 |
| `CRON-NONE` | 声明性条目：本二进制不存在定时或常驻调度子命令。 |
| `SERVE-PORT0` | `--port 0` 让操作系统分配临时端口，实测会落到 18000–18999 之外；R2 返工书要求端口限定在该区间且不得使用 `--port 0`，因此本行不再执行。 |
| `SERVE-PORT0-HEALTH` | 依赖上一行的会话，本行随之 BLOCKED。 |
| `DASH-OPEN` | `--open` 会拉起系统默认浏览器，属沙箱外 GUI 副作用，无法产出机器可读证据。 |
| `DASH-DEFAULT-OUT` | 省略输出路径会把产物写进仓库根，污染被测工作区与被保护文件的哈希。 |

**已于 L5（`c895274`）解除的 2 条（D-08 修复后不再缺能力）**：

| OP-ID | 解除依据（可复跑） |
|---|---|
| `SERVE-8080-LINKED` | `trade dashboard --api-base <url>` 落地，探活基址可用 18000–18999 内的实际端口覆盖，不再需要 8080 授权。L5 `E2E-N-96` PASS：产物 `LOCAL_API_BASE = 'http://127.0.0.1:18436'`（= 传入值）、exit `0`、六表 Δ 0 |
| `SERVE-DUAL-MODE-GREENLIGHT` | 无头浏览器在本线可用（`E2E-P-17` 已在用），叠加的固定端口阻塞随 D-08 一并消失。L5 `E2E-N-97` PASS：serve(18186) + `--api-base` → 顶栏 `class=local` + 「本地引擎已联动」，停机后同页降级 `standalone`，两态 DOM >1000 字符且 NaN=0 |

8 条 BLOCKED 行同样在各自的操作行备注栏里写明了缺失能力，两处一致（原为 10 条，扣除上述 2 条已解除项）。

---

## 15. 隔离自查（全部命令可复跑）

### 15.1 四项隔离计数

| 检查 | 命令 | 输出 |
|---|---|---|
| 缺 `--db /tmp/…` 的 trade 调用数（期望 0） | `grep -E '(^|/)trade( |$)' docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/commands.log | grep -vc -- '--db /tmp/' || true` | `0` |
| HOME 不是沙箱 fakehome 的 trade 调用数（期望 0） | `grep -E '(^|/)trade( |$)' docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/commands.log | grep -vc "HOME=/tmp/qa-tp5a3bfad8-L1r2-20261022-222110/fakehome" || true` | `0` |
| 端口不在 18000–18999 的 serve 行数（期望 0） | `grep -E 'trade serve' docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/commands.log | grep -oE '\-\-port [0-9]+' | awk '{print $2}' | grep -vcE '^18[0-9]{3}$' || true` | `0` |
| 违规文件里除两条自检以外的拒绝行数（期望 0） | `grep 'GUARD-REFUSED' docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/harness-guard-violations.txt | grep -vc 'ZZ-GUARD-SELFTEST' || true` | `0` |
| 两条自检的拒绝行数（应为 2） | `grep 'GUARD-REFUSED' docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/harness-guard-violations.txt | grep -c 'ZZ-GUARD-SELFTEST' || true` | `2` |

### 15.2 与 21:33:36 基准的逐项比对

基准文件：`reports/tp-5a3bfad8-isolation-baseline-20261022-213336.txt`；两列快照取自本目录的 `isolation-start.txt`（开工，第一个产物）与 `isolation-end.txt`（收工，最后一个产物）。

| 条目 | 基准 sha256 | 开工快照 | 收工快照 | 判定 |
|---|---|---|---|---|
| 生产账本 trade.db | `1ec361a647480979…` | `1ec361a647480979…` | `1ec361a647480979…` | 一致 |
| 生产账本 trade.db-wal | `e3b0c44298fc1c14…` | `e3b0c44298fc1c14…` | `e3b0c44298fc1c14…` | 一致 |
| 看板 lot-trader-global-dashboard.html | `697b2a27eac0cdfb…` | `697b2a27eac0cdfb…` | `697b2a27eac0cdfb…` | 一致 |
| 二进制 ./trade | `3d275c9428a73724…` | `3d275c9428a73724…` | `3d275c9428a73724…` | 一致 |
| docs/qa/acceptance-cases.md | `c68b4ab1e729040f…` | `c68b4ab1e729040f…` | `c68b4ab1e729040f…` | 一致 |
| docs/qa/evidence-template.md | `bb438ab4665ecbe2…` | `bb438ab4665ecbe2…` | `bb438ab4665ecbe2…` | 一致 |
| docs/qa/regression-baseline.md | `08f817390c478d57…` | `08f817390c478d57…` | `08f817390c478d57…` | 一致 |
| docs/qa/release-gate.md | `969f3c8c34b63ed8…` | `969f3c8c34b63ed8…` | `969f3c8c34b63ed8…` | 一致 |
| docs/qa/safety-checklist.md | `41992973659cd80e…` | `41992973659cd80e…` | `41992973659cd80e…` | 一致 |
| docs/qa/reports/release-gate-report-latest.md | `428b27a93894c26c…` | `428b27a93894c26c…` | `428b27a93894c26c…` | 一致 |

`~/.lot-trader/` 条目集合：基准 `.|session.token.stale-bak`，开工 `.|session.token.stale-bak`，收工 `.|session.token.stale-bak`——三者相同（该判定由两份快照与基准文件解析得出，不是人工断言）。 HEAD `20812431f85110879240143e08d185ac2184164a`。

```
$ diff isolation-start.txt isolation-end.txt
1c1
< TIMESTAMP: 2026-10-22 22:21:11 +0800
---
> TIMESTAMP: 2026-10-22 22:22:43 +0800
```

### 15.3 收工时 git status

```
$ git -C <repo> status --porcelain
M docs/qa/reports/release-gate-report-latest.md
?? docs/qa/e2e-runbook.md
?? docs/qa/e2e-test-flow.md
?? docs/qa/evidence/RUN-HISTORY-DISCLOSURE.txt
?? docs/qa/evidence/release-gate-20261022-153047/
?? docs/qa/evidence/release-gate-20261022-163227-commit-a4feddb/
?? docs/qa/evidence/release-gate-20261022-165604-commit-2081243/
?? docs/qa/evidence/tp-5a3bfad8-L1-20261022-174532-commit-2081243/
?? docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-220225-commit-2081243/
?? docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-221059-commit-2081243/
?? docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-221614-commit-2081243/
?? docs/qa/evidence/tp-5a3bfad8-L1r2-20261022-222110-commit-2081243/
?? docs/qa/evidence/tp-5a3bfad8-L2-20261023-015759-commit-20812431/
?? docs/qa/evidence/tp-5a3bfad8-L2-20261023-131811-commit-20812431/
?? docs/qa/evidence/tp-5a3bfad8-L2-20261023-131915-commit-20812431/
?? docs/qa/evidence/tp-5a3bfad8-L2-20261023-143904-commit-20812431/
?? docs/qa/evidence/tp-5a3bfad8-L2-20261023-144014-commit-20812431/
?? docs/qa/evidence/tp-5a3bfad8-L2-20261023-144410-commit-20812431/
?? docs/qa/evidence/tp-5a3bfad8-L2-20261023-144518-commit-20812431/
?? docs/qa/evidence/tp-5a3bfad8-L2-20261024-162950-commit-20812431/
?? docs/qa/evidence/tp-5a3bfad8-L2-20261024-163055-commit-20812431/
?? docs/qa/evidence/tp-5a3bfad8-L3-20261023-014517-commit-2081243/
?? docs/qa/evidence/tp-5a3bfad8-L4-line-20261023-143729/
?? docs/qa/evidence/tp-5a3bfad8-L4-line-B-20261024-153427/
?? docs/qa/evidence/tp-5a3bfad8-L4-run-20261024-153439-commit-2081243/
?? docs/qa/guard-unit-test-map.md
?? docs/qa/reports/archive/
?? docs/qa/reports/e2e-report-20261024-153440-commit-2081243.md
?? docs/qa/tools/
?? docs/qa/user-operation-matrix.md
```

### 15.4 serve 的 host、凭据与清理（按实测口径）

- 本轮 18 个 serve 会话的 `--host` 取值分布：`127.0.0.1`×13、`0.0.0.0`×1、`192.168.31.44`×1、`'*'`×1、`localhost`×1、`::1`×1；其中被拒绝的三个非回环取值在绑定阶段即退出，未建立监听。
- 未带 `--token-file` 的会话共 4 个：`SERVE-BIND-ANY0`、`SERVE-BIND-LAN`、`SERVE-BIND-WILD`、`SERVE-DEFAULT-TOKENFILE`（三个门禁用例在被拒前未触及凭据；`SERVE-DEFAULT-TOKENFILE` 故意不传，用于验证默认路径派生）。
- 实际绑定：`localhost` 与 `127.0.0.1` 走 IPv4 回环；`::1` 只绑 `[::1]`（原文 `trade   65103 ivywu    7u  IPv6 0x5b11eb77772dd301      0t0  TCP [::1]:18599 (LISTEN)`），IPv4 回环探它会连接被拒，见 `SERVE-BIND-IPV6LOOP-HEALTH-V6`。
- serve 会话退出码分布（由 commands.log 推导）：exit `0`×14、exit `1`×4。非零退出的是`SERVE-BIND-ANY0`、`SERVE-BIND-LAN`、`SERVE-BIND-WILD`、`SERVE-PORT-CONFLICT-SECOND`——它们是绑定被拒或端口占用，都在**建立监听之前**退出，不涉及停机路径。
- 真正建立监听并走停机路径的会话全部以 SIGTERM/SIGINT 停止且退出码为 0，端口释放；18000–18999 内收工后只剩开工前就存在的监听。
- 证据拷入本目录后，`/tmp` 沙箱的数据库、生成页面与一次性凭据已删除；复现工具保留在 `harness-r2/`。

### 15.5 checker 三次运行原文

本轮把 evidence_missing 的检查范围从「操作表证据列」扩大到「守卫表与缺陷表的证据列」，因此把三次输出另存为 `check-op-matrix-CORRECTION.out` / `check-op-matrix-canary-CORRECTION.out`（旧文件保持原样不再引用）。覆盖率明细见 verbose 行：操作表与守卫/缺陷表分别计数。

```
$ bun docs/qa/tools/check-op-matrix.ts
commands=53 flags=123 missing=0 extra=0 evidence_missing=0 ghost_db=0
$ bun docs/qa/tools/check-op-matrix.ts --inject-canary
commands=53 flags=124 missing=1 extra=0 evidence_missing=0 ghost_db=0

# 覆盖率（verbose，分表计数、不重复计数）
help invocations: 53 | matrix rows: 316 | evidence paths checked: 483
coverage: op_table=316 guard_table=94 defect=19 draft_diff=19 observations=21 unique_total=441

# 变异测试（原文逐行取自 check-op-matrix-MUTATION-CORRECTION.out，不是手写常量）
变异测试（在 /tmp 副本上做，原件不动；三条都是守卫表的证据路径）

A) G-08 SERVE-HOST-FORGERY.body.txt -> 不存在的名字
$ QA_MATRIX_PATH=/tmp/mut/HOST.md bun docs/qa/tools/check-op-matrix.ts
commands=53 flags=123 missing=0 extra=0 evidence_missing=1 ghost_db=0
commands=53 flags=123 missing=0 extra=0 evidence_missing=1 ghost_db=0
evidence_missing: SERVE-HOST-FORGERY.body.txt.nonexistent

B) G-38 ACC-ADD-DUP.stderr -> 不存在的名字
$ QA_MATRIX_PATH=/tmp/mut/G38.md bun docs/qa/tools/check-op-matrix.ts
commands=53 flags=123 missing=0 extra=0 evidence_missing=1 ghost_db=0
commands=53 flags=123 missing=0 extra=0 evidence_missing=1 ghost_db=0
evidence_missing: ACC-ADD-DUP.stderr.nonexistent

C) G-14 -> 无后缀名字
$ QA_MATRIX_PATH=/tmp/mut/NOSUF.md bun docs/qa/tools/check-op-matrix.ts
commands=53 flags=123 missing=0 extra=0 evidence_missing=1 ghost_db=0
原文见 `check-op-matrix-MUTATION-CORRECTION.out`；`QA_MATRIX_PATH` 是本轮为变异测试新增的环境变量覆盖点，默认仍读取仓库内的矩阵。
```

### 15.6 本轮作废的证据目录（按目录扫描得出，不写死）

L1r2 前缀的目录共 4 个，其中 1 个为权威目录，其余 3 个作废：

| 目录 | 作废原因 |
|---|---|
| `tp-5a3bfad8-L1r2-20261022-220225-commit-2081243` | BSD `date` 不支持 `%N`，日志时间戳写成 `3N`（无毫秒）；隔离计数端口正则写成四位，对五位端口永远输出非零。（详见同目录 `ABANDONED-ATTEMPT-NOTE.txt`） |
| `tp-5a3bfad8-L1r2-20261022-221059-commit-2081243` | serve 退出码跨脚本 `wait` 失败（记成 127/超时）；后台启动导致 SIGINT 被忽略，SIGINT 用例送不到信号。（详见同目录 `ABANDONED-ATTEMPT-NOTE.txt`） |
| `tp-5a3bfad8-L1r2-20261022-221614-commit-2081243` | serve 已修好，但三份派生汇总文件不合格（计数双写、熵审计在停机前取数、指向未生成产物的占位文案）。（详见同目录 `ABANDONED-ATTEMPT-NOTE.txt`） |

### 15.7 本轮更正件

| 文件 | 说明 |
|---|---|
| `PRICE-GUARD-AUDIT-CORRECTION.txt` | 更正同目录 `PRICE-GUARD-AUDIT.txt` 的标题与 NaN 识别方式（本题第 9 项） |
| `GENERATOR-NOTES-CORRECTION.txt` | 说明 `setup-check.sh` 并不存在、`run-all.sh` 里那句是陈旧注释，以及 `harness-r2/` 各脚本是否与实跑时相同 |
| `r1-guard-table-source.md` | 第 1 轮守卫表原文（Master 提供），§16 的对照依据 |

### 15.8 第 1 轮事故更正
见 `isolation-incident-CORRECTION.txt`：指出第 1 轮说明里「每次 serve 都传了 `--token-file` 与 `LOT_TRADER_TOKEN_FILE`」不成立，并说明本轮改为机械强制。原文件未删未改。

## 16. 守卫首轮对照（首轮 `G-01`~`G-44`；`G-45` / `G-46` 为后续新增）

对照源：`r1-guard-table-source.md`（第 1 轮守卫表原文，首轮表前两列是「所属操作行 | 类型」）。判定规则：类型逐字比对（忽略首轮 `→ 缺陷` 这类编辑标注）；触发条件引用的操作行按家族通配展开后与本轮覆盖集合比对。本轮丢弃的首轮操作行 **0** 处、类型变化 **0** 处、含义变化 **1** 处（三个数字都由本段之前的对照计算得出，不是人工断言）。

| G-ID | 本轮类型 | 首轮类型 | 本轮触发条件 | 判定 | 说明 |
|---|---|---|---|---|---|
| **G-01** | 安全门 | 安全门 | 任一 trade 调用未带 `--db /tmp/...`，或内联 HOME 指向沙箱之外 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 ZZ-GUARD-SELFTEST-BAD-HOME, ZZ-GUARD-SELFTEST-HOME-CONTROL, ZZ-GUARD-SELFTEST-MISSING-DB |
| **G-02** | 安全门 | 安全门 | 同时给出环境变量与显式 `--db` | 措辞调整 | 类型相同；触发条件重写，引用的操作行完全覆盖首轮 |
| **G-03** | 安全门 | 安全门 | 需要在**不带 `--db`** 的前提下观测环境变量与默认路径回退 | 措辞调整 | 类型相同；触发条件重写，引用的操作行完全覆盖首轮 |
| **G-04** | 安全门 | 安全门 | `--host` 取非回环地址；或取允许的本地别名 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 SERVE-BIND-LOCALHOST-HEALTH-V4 |
| **G-05** | 安全门 | 安全门 | 自动生成会话凭据 | 措辞调整 | 类型相同；触发条件重写，引用的操作行完全覆盖首轮 |
| **G-06** | 安全门 | 安全门 | 访问受保护端点时缺少凭据、凭据错误，或查询串凭据错误 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 SERVE-200-LOTS, SERVE-200-QUERYTOKEN, SERVE-200-SUMMARY |
| **G-07** | 安全门 | 安全门 | 未授权响应体 | 措辞调整 | 类型相同；触发条件重写，引用的操作行完全覆盖首轮 |
| **G-08** | 错误码映射 | 错误码映射 | 伪造 Host 头 | 措辞调整 | 类型相同；触发条件重写，引用的操作行完全覆盖首轮 |
| **G-09** | 错误码映射 | 错误码映射 | Origin 不在本地白名单内 | 措辞调整 | 类型相同；触发条件重写，引用的操作行完全覆盖首轮 |
| **G-10** | 错误码映射 | 错误码映射 | 写方法打到只读引擎；或浏览器预检 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 SERVE-HEALTH |
| **G-11** | 错误码映射 | 错误码映射 | 请求不存在的端点或路径穿越 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 SERVE-200-LOTS |
| **G-12** | 状态转换 | 状态转换 | 收到 SIGTERM 或 SIGINT | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 SERVE-ENTROPY-1, SERVE-ENTROPY-2, SERVE-ENTROPY-3, SERVE-QUIET |
| **G-13** | 状态转换 | 状态转换 | 显式口令加已存在的外部凭据文件 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 SERVE-EXPLICIT-TOKEN-200 |
| **G-14** | 拦截 | 拦截 | 账本结构异常：有成交流水但批次表为空 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 SERVE-DEGRADED-EMPTY-SUMMARY, SERVE-DEGRADED-ORPHAN-HEALTH, SERVE-DEGRADED-ORPHAN-SUMMARY |
| **G-15** | 拦截 | 拦截 | 买入后单标的估值占组合比例越过硬顶线 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 BUY-SKIP-RISK, RISK-PASS-UNDER |
| **G-16** | 拦截 | 拦截 | 占比恰好落在硬顶线上；或刚越过线上一点点 | 措辞调整 | 类型相同；触发条件重写，引用的操作行完全覆盖首轮 |
| **G-17** | 拦截（旁路） | 拦截（旁路） | 显式传入跳过风控的参数 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 BUY-RISK-WOULD-BLOCK, RISK-BLOCK-OVER |
| **G-18** | 拦截（边界） | 拦截（边界） | 在同一标的里持续累加到很大的金额，而组合中没有其他标的 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 RISK-BLOCK-OVER, RKO-OVER-30PCT |
| **G-19** | 拦截 | 拦截 | 同一血缘链在冷却窗口内再次加仓 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 ADD-AFTER-48H |
| **G-20** | 状态转换 | 状态转换 | 血缘链最近一次加仓已在冷却窗口之外 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 ADD-COOLDOWN-BLOCK |
| **G-21** | 拦截（可绕过） | 拦截（可绕过）→ **缺陷** | 把本次加仓的成交时间写成未来值，从而让冷却判断以为已过窗口 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 ADD-AFTER-48H |
| **G-22** | 拦截 | 拦截 | 股数不是最小交易单位的整数倍，或不是正数 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 ADD-QTY-EXPLICIT, BUY-OK-FLAGS |
| **G-23** | 拦截 | 拦截 | 平仓数量超过剩余可用数量 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 CLOSE-PARTIAL |
| **G-24** | 拦截 | 拦截 | 指定的账户与批次归属不符 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 CLOSE-ACCT-OK |
| **G-25** | 拦截 | 拦截 | 法定 T+1 标的当日买入、账户内没有历史底仓 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 CLOSE-SUBCORE-T1 |
| **G-26** | 状态转换 + 拦截 | 状态转换 + 拦截 | 用代冲参数借用历史底仓卖出当日份额 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 XACC-SUBCORE-NOFLAG |
| **G-27** | 状态转换 | 状态转换 | 对已平仓批次再次平仓 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 CLOSE-FULL |
| **G-28** | 状态转换 | 状态转换 | 只修改决策理由 | 措辞调整 | 类型相同；触发条件重写，引用的操作行完全覆盖首轮 |
| **G-29** | 状态转换 | 状态转换 | 跌幅越过深跌线 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 SCAN-ADD-RUN, SCAN-DEEP-AFTER |
| **G-30** | 拦截 / 状态转换 | 拦截 / 状态转换 | 浮盈越过激活线且自峰值回撤越过阈值 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 SCAN-TRAIL-BELOW |
| **G-31** | 拦截（负向防误杀） | 拦截（负向防误杀） | 回撤低于阈值；或浮盈低于止盈线 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 SCAN-THR-OVERRIDE, SCAN-TRAIL-RUN |
| **G-32** | 状态转换 | 状态转换 | 按结算机制与账户内底仓可用量分流 | 措辞调整 | 类型相同；触发条件重写，引用的操作行完全覆盖首轮 |
| **G-33** | 状态转换 | 状态转换 → **缺陷** | 用阈值覆盖参数调整止盈线 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 SCAN-THR-DEFAULT |
| **G-34** | 状态转换 | 状态转换 | 登记现金分红后读取持仓视图 | 措辞调整 | 类型相同；触发条件重写，引用的操作行完全覆盖首轮 |
| **G-35** | 安全门 | 安全门 | 生成单文件看板 | 一致 | 类型、触发条件与所属操作行逐字相同 |
| **G-36** | 安全门 | 安全门 | 有 / 无会话凭据 | 措辞调整 | 类型相同；触发条件重写，引用的操作行完全覆盖首轮 |
| **G-37** | 状态转换 | 状态转换 | 指定自定义模板 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 DASH-OUT-NONE, DASH-TEMPLATE-MISS |
| **G-38** | 拦截 | 拦截 | 重复账户 ID、非法券商、缺名称、非法币种 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 ACC-ADD-ALPHA, ACC-ADD-BETA, ACC-ADD-GAMMA |
| **G-39** | 状态转换 | 状态转换 | 未登记的账户或标的 | **含义变化（更正首轮事实错误）** | 方向相反：首轮写「symbols 未新增行」，本轮写「symbols 落一行」。两轮记录的行数差值其实都是 +1：首轮 `tp-5a3bfad8-L1-20261022-174532-commit-2081243/BUY-UNKNOWN-SYM.rows-before/after.txt` 为 18→19，本轮本目录的 `BUY-UNKNOWN-SYM.rows-before/after.txt` 同为 18→19。因此首轮那句是事实性错误，本轮按实测更正；类型与触发条件本身未变。 |
| **G-40** | 拦截 | 拦截 | 设置组合预算环境变量后按它换算占比 | 措辞调整 | 类型相同；触发条件重写，引用的操作行完全覆盖首轮 |
| **G-41** | 错误码映射 | 错误码映射 | 目标端口已被占用 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 SERVE-PORT-CONFLICT-HOLDER |
| **G-42** | 安全门 | 安全门 | 连续多次自动生成会话凭据 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 SERVE-ENTROPY-1, SERVE-ENTROPY-2, SERVE-ENTROPY-3 |
| **G-43** | 错误码映射 | 错误码映射 | `--json` 与 `--quiet` 的输出契约 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 SERVE-START |
| **G-44** | 错误码映射 | 错误码映射 → **缺陷** | 阈值参数不是合法 JSON；或阈值取值类型非法 | 措辞调整 | 类型相同；触发条件重写，并补充了实测操作行 SCAN-THR-DEFAULT, SCAN-THR-OVERRIDE |
| **G-45** | 拦截 | (首轮表无此条) | 价格不是有限正数（非数值、零、负数） | 新增 | 后续新增守卫（首轮表只到 G-44）；L5 复核：违规侧全部 exit 1 · Δ 0 |
| **G-46** | 拦截 | (首轮表无此条) | 非价格类数值旗标（`--fee` / `--qty` / `--days` 等）取非法字面量 | 新增 | L5 核验新增守卫（缺陷 D-10）；对应成对用例 `E2E-N-100` / `E2E-P-19` |

含义变化/类型变化条数：**1**（G-39）。其余条目都是措辞调整：触发条件被重写得更具体、或补充了本轮实测的操作行，类型与所覆盖的操作行集合均未改变。

两处需要单独说明的条目：

- **G-39**（**含义变化（更正首轮事实错误）**）：类型与触发条件与首轮一致，但**方向相反**——首轮矩阵写「symbols 未新增行」，本轮写「symbols 落一行」。两轮记录的行数差值其实都是 +1：首轮 `tp-5a3bfad8-L1-20261022-174532-commit-2081243/BUY-UNKNOWN-SYM.rows-before/after.txt` 为 18→19，本目录的 `BUY-UNKNOWN-SYM.rows-before/after.txt` 同为 18→19，`DIV-ADD-UNKNOWN-SYM.rows-before/after.txt` 亦为 18→19。所以这不是措辞调整，而是更正首轮的事实错误。（标的那两行期望来源标为 `§0 分类规则`：help 只对账户写明自愈登记，对标的没有登记说明。）
- **G-30**（措辞调整）：首轮的操作行本轮**全部保留**（`SCAN-TRAIL-RUN` 在违规侧，`SCAN-TRAIL-BELOW` 与 `SCAN-TP-RUN` 在合法侧，后者的 `SCAN-TP-RUN.stdout` 里 `TRAILING_STOP_ALERT` 出现 0 次、只有止盈信号，是不触发样本），类型与主题均未变。
- **G-14**（措辞调整）：类型与触发条件同首轮一致；本轮只把两侧按**违规/合法**重新分组（异常账本该被标记为违规侧、空库不该被误报为合法侧），并保留了 degraded 标志断言，未改类型与触发条件。

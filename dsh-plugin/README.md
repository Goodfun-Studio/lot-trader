# lot-trader × DSH 插件（`@goodfun-studio/dsh-lot-trader`）

把 lot-trader 操盘引擎接进 DeepSeek Harness 的**原生壳**。

引擎一行没动：所有账本语义仍住在编译好的 `trade` 二进制里。这个包只负责
「把它的契约原样端到模型和用户眼前」——读命令变成模型能直接调的工具，
写命令挂上审批闸门，操盘纪律进 systemPrompt，持仓看板长在 Web GUI 侧边栏里。

## 安装

从插件市场装，或：

```bash
dsh plugin add @goodfun-studio/dsh-lot-trader
```

**首次使用不需要手工准备引擎**：插件发现本机没有 `trade` 时，会自动从
[GitHub Releases](https://github.com/Goodfun-Studio/lot-trader/releases) 拉取
对应平台的二进制到 `~/.lot-trader/bin/`。账本（`~/.trade/trade.db`）在第一次
写操作时由引擎自己创建。

支持平台：macOS (x64 / Apple Silicon 经 Rosetta) 与 Linux x64。

## 它替换掉了什么

在此之前，模型要操盘得先读一遍 `SKILL.md`、记住 `trade lot buy --symbol ... --json`
的每个参数、拼 bash、再解析 stdout。这条路径有三个已知伤口：

| 伤口 | 后果 |
| --- | --- |
| 靠 markdown 教模型拼命令行 | 参数写错才发现，且没有任何 schema 约束 |
| 命令全靠 bash | 在 `workspace-write` 沙箱下**连只读查询都跑不动**——`trade` 每次启动都要 initSchema/WAL，`~/.trade/` 不可写就直接 `SQLITE_READONLY` |
| 写操作不可拦 | 模型调 `trade lot buy` 与调 `ls` 的审批待遇一样，真金白银没有额外关卡 |

这个插件把三条一起修了。

## 装了什么

### L1 · 十一个原生工具（读 6 / 写 5）

| 读（免审批） | 写（**必过审批**） |
| --- | --- |
| `trade_position` 三层持仓全景 | `trade_lot_buy` 买入建仓 |
| `trade_lot_list` 批次明细（插件侧排序+分页） | `trade_lot_add` 梯级加仓 |
| `trade_scan` 盘中操盘信号 | `trade_lot_close` 平仓 / 底仓代冲 |
| `trade_stats` 战绩多维归因 | `trade_dividend_add` 录入分红 |
| `trade_physics` 物理动量雷达 | `trade_account_add` 登记账户 |
| `trade_dividend_list` 分红流水 | |

写集合只有一处真相来源（`tools.js` 的 `WRITE_TOOLS`），审批闸门直接读它，
不在别处再列一遍——所以「新加一个写工具却忘了挂闸门」在结构上不可能发生。

审批走 `tools/pre-execute` 返回 `ask`（不是 `ctx.tools.guard()`）：guard 是同步的、
只能 deny，而这里要的是挂起等人点头。非本插件的工具一律 `next()` 让行，
绝不吞掉别人的决策。

审批提示里带的是**这一单的具体内容**，不是干巴巴的工具名：

```
即将写入你的操盘账本：买入 518880.SH 2000 股 @ 6.12 [CMB]。批准后这笔操作会真实落库。
```

### L1 · 操盘纪律进 systemPrompt

`renderDiscipline()` 把八条硬纪律写成常驻切片（`order` 默认 170，落在工具指引区）：

单笔批次独立监控 · 严禁深跌冻结（≤ -20% 保持 ACTIVE 出 `DEEP_VALUE_ALERT`）·
48 小时加仓防抖 · 单标的 30% 仓位硬顶 · 多账户底仓代冲强隔离 · T+0/T+1 制度 ·
写操作需审批 · 数据诚实（拿不到现价不许讲成「没变化」）。

这些**不是**插件发明的新政策，而是编译引擎里已经硬编码的执行事实——
切片的作用是让模型在撞上去之前就知道闸门在哪。

### L2 · 原生持仓看板

侧边栏图标（`sidebar.panellist`）+ 中央主视口面板（`main`，key 与图标 id 同为 `lot-trader`）。

- **组合总览**：总成本 / 总市值 / 浮盈 / 收益率 / 活跃批次 / 标的数 / 满仓额度
- **标的全景卡**：现价、双向仓位条（成本仓位 vs 市值仓位，超 30% 硬顶转红告警）、
  组合占比、建议加仓区间（≤ 最近买入价 ×0.90）、建议止盈区间（≥ ×1.10）、
  物理雷达摘要（F / F_eff / a / m / 置信等级 / 60 日分位 / 回撤），
  `LOW` 置信会显式标注「参与度不足，强合力只算待确认候选」
- **在场批次双视图**（**物理隔离**，不是同一张表换排序）：
  - *时间维度视图*：按买入时间倒序。配独立的「时间视角」统计条
    （最近买入 / 48h 内建仓加仓 / 加仓批次 L2+ / 涉及标的）——
    用来复盘资金进出轨迹与防抖执行情况
  - *盈亏率维度视图*：按浮动盈亏率倒序。配独立的「盈亏分层透视」条
    （深度击球区 → 深跌观察 → 浅度回撤 → 成本线 → 止盈梯队 → 高位浮盈，
    每档带笔数与浮盈合计）——用来识别待止盈梯队、评估风险暴露、
    定向挑最深负收益批次做代冲对冲
- **历史战绩**：总平仓 / 胜率 / 累计净利润 / 盈亏比 / 日内做 T，
  并按操盘类别（普通波段 / 天然 T+0 / 底仓代冲做 T）与标的归因
- 账户筛选 + 标的/批次ID 搜索

样式全部走宿主主题 token（`--dsw-alias-*`），跟随亮/暗主题。

## 数据流

```
浏览器面板 ──GET /api/lot-trader/snapshot──▶ Host 插件 ──spawn──▶ trade position --json
     ▲        （同源 + 凭据）                 │                trade stats    --json
     └──────────── 只读快照（回环 + 认证）─────┘
```

浏览器**不**直连 `~/.trade/trade.db`，也**不**直连腾讯行情：现价由 Host 侧的
`trade position` 带出来，页面只消费一份只读快照。账本不出本机，路径与密钥不进浏览器，
页面也不必自己重算任何成本口径。

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/api/lot-trader/snapshot` | GET | 读当前快照；冷启动时这一次请求顺便等首帧 |
| `/api/lot-trader/refresh` | POST | 强制立即重算 |

### 准入与跨域（两道闸，缺一不可）

**1. 物理层**：只接受回环 socket（`127.0.0.1` / `::1` / `localhost`），非回环一律 403。

**2. 身份层**：把请求交给 Host 的 `connection.requestRejection({ headers })`，由它执行
**Host / Origin 检查 + 浏览器凭据认证**；返回 401 / 403 原样透出。

只有第一道是**不够**的。浏览器里任意网页发起的 `fetch` 同样来自 `127.0.0.1`，
回环判断对它完全无效——必须靠第二道的 Origin 与凭据校验才拦得住。

因此本插件：

- **不声明任何 CORS 头**。写 `access-control-allow-origin: *` 等于把持仓开放给
  任意网页读取，即使路由只监听回环也没用。
- **把 `connection` 当硬依赖**：拿不到它就做不了凭据认证，快照路由索性不挂载。
  宁可面板拿不到数据，也不把账本暴露在无认证的只读接口上。
- **判断不了就拒绝**：认证链路自身抛错时同样返回 403，不因「拿不到结论」而放行。

面板是**同源**读取（与路由同属宿主 Web 服务），显式带 `credentials: 'same-origin'`，
因此不需要、也不应该有任何 CORS 放宽。

## 刷新策略

`position` 要拉全市场行情与 60/250 日历史 K 线（本机实测 45 标的约数秒到数十秒），
所以：

- 前台读缓存，**后台异步刷新，同一时刻只允许一次在途重算**；
- 周期刷新**只在「最近有人读过快照」时才真跑**（`lastReadAt < 2 × pollMs`）——
  没人看的时候不烧行情；
- 任何写工具成功后立刻让快照失效，看板下一次读取就能看到这笔成交；
- `position` 与 `stats` 各错各的：`position` 拿不到才标 `degraded`（并在面板顶栏
  挂黄色告警条），`stats` 拿不到只降级战绩区块。**绝不用「部分失败」把整块数据说成「空仓」**。

## 配置

本包自带的 `cordis.patch.yml` 声明默认值；要改就在你自己的 profile patch
（`~/.dsh/profiles/desktop/cordis.patch.yml`）里按 id 覆盖——那一层是你的，升级不丢：

```yaml
- id: lot-trader
  config:
    cap: 300000                    # 单标满仓额度（元），0 = 沿用引擎解析
    pollSeconds: 30
    requireApprovalForWrites: true # 想放行自动交易就设 false（不建议）
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `binaryPath` | `''` | `trade` 路径。留空按探测链找（见下） |
| `autoDownload` | `true` | 探测不到 `trade` 时自动从 GitHub Releases 下载 |
| `dbPath` | `''` | 账本路径。留空 = `$LOT_TRADER_DB` → `$TRADE_DB_PATH` → `~/.trade/trade.db` |
| `cap` | `0` | 单标满仓额度。**0 = 不传 `--cap`**，沿用引擎解析链 |
| `pollSeconds` | `45` | 后台刷新间隔，下限 15 |
| `requireApprovalForWrites` | `true` | 写操作是否强制审批 |
| `disciplineOrder` | `170` | 纪律切片在 systemPrompt 里的顺序 |

### 引擎二进制从哪来

探测链（第一个命中的就用）：

1. `config.binaryPath`
2. bundle 同级仓库二进制（插件住在 lot-trader 仓库内时）
3. `~/.local/bin/trade`
4. `~/.lot-trader/bin/trade`（**自动下载缓存**）
5. `PATH` 上的 `trade`

整条链都没命中且 `autoDownload: true`（默认）时，插件从
[Releases](https://github.com/Goodfun-Studio/lot-trader/releases) 拉当前平台的产物
（`trade-darwin-arm64` / `trade-darwin-x64` / `trade-linux-arm64` / `trade-linux-x64`），
落到 `~/.lot-trader/bin/trade` 并 `chmod 755`，然后立刻重算一次快照——
用户不需要任何手工步骤。

**两条下载路径并行竞速**：

1. `github.com/.../releases/latest/download/<asset>` —— 标准直链
2. `api.github.com` 的 asset API —— 会 302 到 `release-assets.githubusercontent.com`

两条同时发起，谁先拿到响应头用谁，另一条立刻中止。这不是过度设计：
实测在部分网络环境下 `github.com` 主站连不上、而 `api.github.com` 与
release CDN 都通；只有一条路径会让这类用户直接失败。同理，
`fetch()` 收到响应头就该撤掉「等响应头」的超时——否则 89MB 的 body
会在读了一半时被掐断（这个坑真踩过）。

**校验 fail closed**：`sha256` 取不到就**拒绝安装**，绝不静默装一个没校验过的可执行文件。
两条路径都拿不到校验和时给出明确原因与三条自救路径，而不是「凑合装上」。
校验和不匹配同样拒绝（疑似篡改或截断）。

下载失败**不静默**：`binaryStatus` 转 `failed`，面板顶栏红字显示原因，
并提示三条自救路径（手动放到缓存路径 / 配 `binaryPath` / 关 `autoDownload`）。

所以这个插件对别人可用：npm 包只有约 38 kB 的源码，引擎二进制按需拉取。

### ⚠ 关于 `cap`

引擎默认 50000 元。若你的组合远大于 5 万（实测 45 标的 / 约 135 万成本），
用默认值会让「市值仓位」条**全部顶格**（实测 `513300.SH` 达 489.9%），
于是那根条和 30% 硬顶告警都失去意义。

所以默认给的是 `0`（不干预，让引擎自己解析），但**你要自己设一个真实的单标预算**，
这根条才有意义。设多少只有你知道。

## 开发

```bash
# 全量：51 条契约测试 + 6 条端到端（端到端在本机没有 trade 二进制时自动跳过）
node --test test/*.test.js

# 只跑契约（纯逻辑 + 真打进程，零网络）
node --test test/helpers.test.js

# 只跑端到端：起真账本、跑真引擎、断言最终结果集
node --test test/e2e.test.js
```

### 两类测试的分工

**契约测试**（`test/helpers.test.js`）打的是插件自己的代码路径
（`resolveBinary` → `createCliRunner` → `createTradeTools` → `deriveBoard`），
不 mock CLI、不碰网络。负向断言覆盖：CLI 非零退出必须判 `ok:false` 而不是空数据成功、
非 JSON 输出判 `CLI_NO_JSON`、二进制不存在判 `CLI_NOT_FOUND`、
响应头不得含任何 CORS、Connection 缺席/非回环/认证抛错一律 403、
BUSY_RECOVERY 重试**不得删除**账本 `-wal`、body 停滞必须判死。

**端到端**（`test/e2e.test.js`）用**真实引擎**建临时账本，断言引擎实际返回了什么。
它存在的理由是一条教训：契约测试只锁 argv 形状（「有没有传 `--status`」），
而曾经 `status:"ALL"` 按设计不带 flag、引擎默认又是 ACTIVE，
于是 ALL 静默返回 ACTIVE-only —— **只锁 argv 的测试永远发现不了这种错**。
所以端到端直接对照「插件结果 vs 引擎直调结果」。

端到端还会验证：只读调用不得删除账本的 `-wal`/`-shm`、
单标的 30% 硬顶真的会拦截、非整百股数必须被拒、T+1 当日平仓会被拦。

## 已知情况

- **分层透视与组合总览有千分之几的口径差**。实测：分层浮盈合计 `-143651.63`，
  组合口径 `-144181.04`。原因是引擎的双重计算——标的级用**加权平均成本**聚合，
  批次级用**各批自己的保本单价**，费用率乘在数量不等的两侧，求和不会严格相等。
  这是引擎固有特性，不是派生逻辑的 bug；两处数字都如实呈现，不做粉饰。
- **单标市值占比可以超过 30%**。30% 是**加仓前置**的硬顶（`lot add` 会被拦），
  不是「已有持仓必须低于 30%」。既有持仓涨上去超过 30% 是正常的，
  面板会标红提示，但不会阻止你止盈或平仓。
- **`trade lot list` 只支持 `status` / `symbol` / `account` 三个筛选**，
  排序与分页由插件在拿到结果后做。活跃批次上百笔时**务必用 `limit`/`offset` 翻页**。
- **`trade_position` 默认不内联逐笔批次**（只给 `lots_count`），
  否则上百笔明细会一次性灌进上下文。需要明细用 `include_lots: true`，
  或改用 `trade_lot_list` 分页。
- **只支持 macOS 与 Linux**。Windows 上 `platformTarget()` 返回 `null`，
  会立刻报「没有预编译的 trade 二进制」，而不是走完整条下载流程再收到网络类错误
  —— 因为发布矩阵里确实没有 Windows 产物。要加 Windows 得先在
  `.github/workflows/release-binaries.yml` 的矩阵里补上并验证交叉编译。
- **无法回显引擎版本**。引擎没有 `--version`（执行会打印 usage），
  所以 `engine` 信息里只能给二进制路径与来源（`config.binaryPath` / 仓库同级 /
  `~/.local/bin` / 自动下载缓存 / PATH），给不出「插件 X + 引擎 Y」的版本对照。
  排版本不匹配时请以路径 + 文件时间/大小为据。
- **收益率拿不到时不会当成 0**。现价取不到的批次会落在「收益率不可用」桶，
  表格显示 `—`，排序时排在最后。这是刻意的：把「不知道」显示成「不赚不亏」
  比留空更有害。若你看到 `—`，说明那一笔的现价没取到。
- **配置值解析失败会打日志，但不中断**。例如 `cap: "很多钱"` 会回退到 0
  （沿用引擎解析链）并在日志里 Warn；`cap: "300000"` 这种带引号的数字字符串
  是**能用**的（会被读成 300000），不必去掉引号。

## 发布与发行（维护者）

这个包发布到 npm 后，市场索引（`dshopen.org` 与 `cdn.dsh.so`）会**自动收录**：
它们定时抓 npm 包的 `dsh` 字段、`engines.dsh`、`repository`、下载量与 GitHub stars。
没有人工提交入口，所以「发布」= 发 npm + 挂一个公开 GitHub 仓库。

### 1. 仓库需公开

市场页的 Source 链接与 stars 都读 GitHub，插件自动下载也走 Releases。
`Goodfun-Studio/lot-trader` 已公开（MIT）。

### 2. 发一个带二进制的 Release

仓库里已经准备好 `.github/workflows/release-binaries.yml`：

```bash
git tag v0.1.0
git push origin v0.1.0
```

它会构建 4 个目标（linux/darwin × x64/arm64）、跑 `bun test`、
生成 `.sha256`，然后挂到 Release 上，asset 名与插件的
`platformTarget()` 映射严格一致。

也可以手动触发：Actions → `release-binaries` → Run workflow。

### 3. 发 npm

```bash
cd dsh-plugin
npm login                       # 或设置 NPM_TOKEN
npm publish                     # publishConfig.access 已是 public
```

发布前确认包里只有 9 个文件、约 37 kB：

```bash
npm pack --dry-run
```

### 4. 等索引收录

索引下次抓取时出现，通常几小时内。可通过
`https://dshopen.org/index.json` 搜索包名确认。

### 发布检查清单

- [ ] `private` 字段已移除（npm 会拒绝发布带 `private: true` 的包）
- [ ] `engines.dsh` 与当前 DSH 版本兼容（本机实测 `0.2.1-rc.5`）
- [ ] `repository.url` 指向公开仓库
- [ ] Release 里 4 个平台的 asset 齐全，且带 `.sha256`
- [ ] `npm pack --dry-run` 输出不含 `test/`、`.github/`

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
- **全局交互式看板原生原语**：`trade dashboard [--out <path>] [--open]` 一键生成单文件 HTML 全景看板（标的全景卡片 / 持仓总览 / 时间维度与盈亏率维度物理隔离的批次双视图 / 平仓战绩与穿透弹窗）。
- **批次部分平仓与战绩多维归因**：
  - 支持指定数量部分平仓，状态保持 `ACTIVE` 持续监控；
  - `trade stats` 提供按标的明细、按操盘类型（普通波段、天然 T+0、底仓代冲做 T）的多维战绩归因。

## 快速使用

### 1. 构建与测试
```bash
# 运行 71 项全量核心测试（100% 通过）
bun test

# 编译生成单一独立可执行文件 trade
bun run build
```

### 2. 命令行核心操作
```bash
# 初始买入建仓（支持 JSON 管道输出）
./trade lot buy --symbol 518880.SH --price 6.120 --qty 2000 --json

# 梯级加仓（自动绑定血缘并受 48h 防抖守卫保护）
./trade lot add --parent-lot-id LOT-20261019-001 --price 5.500 --amount 10000 --json

# 批次持仓监控
./trade lot list
./trade lot list --json

# 盘中信号扫描（含常规止盈、移动跟踪止盈、逢低加仓与深跌击球区信号）
./trade scan
./trade scan --json

# 批次平仓（支持全额或部分平仓、底仓代冲做 T）
./trade lot close --lot-id LOT-20261019-001 --price 7.050 --qty 1000 --json
./trade lot close --lot-id LOT-20261019-002 --price 1670.00 --substitute-core --json

# 操盘战绩多维归因统计报表
./trade stats
./trade stats --json

# 全局交互式 HTML 看板（默认当前目录 lot-trader-global-dashboard.html，--open 自动打开浏览器）
./trade dashboard
./trade dashboard --out /tmp/dashboard.html --open --json
```

> 看板生成器资产固化在 `scripts/`（`generate_dashboard.py` + `template_base.html`），随二进制同级部署即可被 `trade dashboard` 自动发现。

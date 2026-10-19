# lot-trader

单笔批次独立盈亏监控与加仓止盈操盘核心引擎 (TypeScript + Bun 单二进制架构)。

## 架构特性
- **TypeScript + Bun 单二进制原生交付**：基于 `bun build --compile` 编译生成零外部依赖、秒级启动的单一独立可执行二进制文件 `./trade`。
- **高性能原生嵌入式持久化**：采用 Bun 原生内置 `bun:sqlite`（C 级别 SQLite 引擎），兼顾极致读写性能与本地私密安全。
- **全生命周期逐批次独立账本**：精确核算单笔全成本保本单价、独立浮动盈亏与实现净利润。
- **天然 T+0 与底仓代冲做 T 仲裁**：自动识别黄金 ETF 等天然 T+0 品种即刻可卖；法定 T+1 标的动态核算昨日可用底仓配额池（Q_available_core），严格阻断无底仓首日建仓卖出（严防裸卖空）。
- **深跌击球区铁律防御**：单笔浮亏跌破 -20% 严禁冻结锁死，严格保持 ACTIVE 活跃监控状态并输出 `DEEP_VALUE_ALERT` 企稳加仓决策。
- **实时行情与容灾**：深度集成腾讯财经实时行情行情源（`qt.gtimg.cn`）并内建离线 Mock 容灾。

## 快速使用

### 1. 构建与测试
```bash
# 运行 12 项全量自动化测试（100% 通过）
bun test

# 编译生成单一独立可执行文件 trade
bun run build
```

### 2. 命令行核心操作
```bash
# 买入建仓（支持 JSON 管道输出）
./trade lot buy --symbol 518880.SH --price 6.120 --qty 2000 --json

# 批次持仓监控
./trade lot list
./trade lot list --json

# 盘中信号扫描
./trade scan
./trade scan --json

# 批次平仓 / 底仓代冲做 T
./trade lot close --lot-id LOT-20261019-001 --price 7.050 --json
./trade lot close --lot-id LOT-20261019-002 --price 1670.00 --substitute-core --json

# 操盘战绩统计
./trade stats
./trade stats --json
```


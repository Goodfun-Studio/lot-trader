# lot-trader 回归基线 (Regression Baseline)

版本：v1.0.0
负责角色：persona-lot-trader-qa
目标：定义 lot-trader 核心能力与质量基线，任何变更不得低于此基线。

---

## 1. 构建与自动化测试基线
- **单测通过率**：`bun test` 16 个测试套件 100% 通过，0 失败，0 挂起。
  - `calc.test.ts`：全成本保本单价与浮盈数学公式
  - `quotes.test.ts`：腾讯行情接口解析与标的规范化
  - `turnover_weighted_force.test.ts`：换手率置信度加权有效合力
  - `physics_numpy_validation.test.ts`：物理动量雷达与 Python NumPy 双引擎对账
  - `position_view.test.ts`：三层分层持仓聚合视图与双仓位占比
  - `db.test.ts`：SQLite 账本表结构与默认数据种子
  - `multi_account.test.ts`：多券商账户独立建账与日内代冲隔离
  - `engine.test.ts`：离散批次状态机与平仓归因
  - `symbol_inference.test.ts`：标的市场推导与环境变量路径覆盖
  - `dividend.test.ts`：现金分红录入与账户隔离
  - `dashboard.test.ts`：单文件 HTML 独立全景看板生成
  - `phase2_strategy.test.ts`：加仓防抖、移动止盈、30% 仓位硬顶
  - `physics.test.ts`：物理合力与流体阻尼
  - `serve_dashboard_dual_mode.test.ts`：看板双模运行与微服务回环鉴权
  - `accounts_reasons.test.ts`：券商注册表与决策理由沉淀
  - `cli.test.ts`：命令行入口与子命令参数交互
- **单二进制编译产物**：`bun run build` 编译生成单一无外部依赖可执行文件 `./trade`，体积稳定在 ~60MB，直接运行 `./trade --help` 正常展示所有子命令。

## 2. 离散批次操盘核心功能基线
- **独立账本核算**：每笔买入必须作为独立 Lot 记录，严禁采用加权平均成本稀释。
- **动态跟踪止盈**：
  - 浮盈达到 +15% 自动激活移动止盈（`trailing_stop_active = 1`）；
  - 持续记录高位峰值价格（`peak_price`）；
  - 从最高价回撤超过 3% 立即发出 `TRAILING_STOP_ALERT` 锁定高位利润。
- **日内底仓置换法则 (Core Substitution)**：
  - 法定 T+1 资产：当日可用底仓量等于前一交易日活跃批次数量总和；
  - 天然 T+0 资产（黄金 ETF 518880.SH、159934.SZ）：当日买入即可 100% 卖出。
- **部分平仓与战绩归因**：
  - 支持指定数量部分平仓，剩余部分保持 `ACTIVE`；
  - `trade stats` 提供按标的明细、按操盘类型（波段、T+0、底仓做 T）的多维战绩归因。

## 3. 看板全景渲染基线
- **双模自适应**：
  - 纯前端自驱模式：不启动 `trade serve` 时，单文件直接双击在浏览器打开，每 5 秒轮询腾讯财经接口，自动刷新现价与浮盈，非交易时段自动降频至 60 秒，支持手动暂停/继续刷新；
  - 本地引擎联动模式：每 3 秒心跳探活 `http://127.0.0.1:8080/api/health`，联通即转绿并对齐本地账本口径；服务关闭后平滑退回自驱模式，全程不报未捕获异常、无白屏、无 `NaN`。
- **界面展示**：
  - 标的全景卡片、持仓总览、批次双视图（时间序与盈亏率序）、平仓战绩穿透弹窗完整可用。


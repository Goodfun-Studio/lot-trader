# lot-trader 验收用例库 (Acceptance Test Cases)

版本：v1.0.0
负责角色：persona-lot-trader-qa

---

## 一、正向核心用例 (Happy Path Cases)

### TC-P01: 账户注册与列表查询
- 动作：执行 `./trade account add CMB_MAIN --name "招商主仓" --broker CMB --json`
- 预期：退出码 0，返回 JSON 包含 `account_id: "CMB_MAIN"`，数据库 accounts 表中成功落盘。

### TC-P02: 独立批次建仓买入
- 动作：执行 `./trade lot buy 600519.SH --price 1600.00 --qty 100 --reason "回调分批低吸" --account CMB_MAIN --json`
- 预期：退出码 0，返回新建 lot 记录，`status: "ACTIVE"`，`cost_price: 1600.00`，`remaining_qty: 100`。

### TC-P03: 跨 48 小时正常阶梯加仓
- 动作：前置批次创建时间在 48 小时前，执行 `./trade lot add --parent-lot-id 1 --price 1500.00 --json`
- 预期：退出码 0，子批次创建成功，`parent_lot_id: 1`，`pyramid_level: 2`，`qty: 600`（按 10,000 元向下取整）。

### TC-P04: 动态移动止盈触发与平仓
- 动作：行情价格上涨至触发 +15% 且从高点回撤超 3%，执行平仓 `./trade lot close 1 --price 1800.00 --reason "移动止盈落袋" --json`
- 预期：退出码 0，批次状态置为 `CLOSED`，实现收益核算准确为 `+20,000.00 元`。

---

## 二、负向防误杀守卫用例 (Negative Guard & Anti-False-Positive Cases)
*防误杀纪律：凡涉及清洗、脱敏、拦截、过滤、状态转换或错误码映射，必须显式定义负向守卫断言，确保合法操作不被误伤，非法操作确定拦截。*

### TC-N01: 合法入参防误杀断言 (Legal Parameter Guard)
- 命题：正常价格（>0）、正常整数股数（>0 且为 100 整数倍）、合理合法代码的建仓买入，绝不被任何安全规则误杀。
- 验证证据：输入合法买入指令，断言退出码为 0，错误流 stderr 为空，数据写入无篡改。

### TC-N02: 48h 冷却期内高频加仓强行拦截断言 (Cooldown Interception)
- 命题：同一父批次在 48 小时内发起二次加仓，必须被坚决拦截，绝不放行。
- 验证证据：在父批次创建后 1 小时内执行加仓，断言退出码为 1，stderr/json 明确输出包含 `cooldown` 或 `48`，数据库中未增加新批次。

### TC-N03: 48h 冷却期外正常加仓放行断言 (Post-Cooldown Allowance)
- 命题：超过 48 小时冷却窗口后的同源加仓，只要总仓位未超限，必须正常放行，严禁被死锁拦截。
- 验证证据：调整父批次创建时间为 50 小时前，执行加仓，断言退出码为 0，成功生成 `pyramid_level=2` 的子批次。

### TC-N04: 浮盈未达标时不误触发移动止盈断言 (Trailing Stop Inactive Guard)
- 命题：当标的浮盈仅为 +5% 或 +10%（未达到 +15% 阈值）时，系统严禁提前激活移动止盈。
- 验证证据：注入行情使得买入 1600.00 的标的现价为 1760.00（浮盈 +10.00%），断言批次 `trailing_stop_active` 严格为 `0`（false），绝不发出卖出报警。

### TC-N05: 高位回撤未达标不误报警断言 (Pullback Threshold Guard)
- 命题：已激活移动止盈的标的，从高点回撤仅 1%~2%（未达到 3% 阈值）时，严禁误触发 `TRAILING_STOP_ALERT`。
- 验证证据：峰值 2000.00，现价 1960.00（回撤 2.0%），断言状态仅为跟踪状态，报警清单中不含该标的。

### TC-N06: 跌幅超 -20% 严禁冻结批次断言 (Deep Value Active Guard)
- 命题：当标的跌幅达到 -25% 时，批次状态严禁被错误置为冻结（FROZEN/LOCKED），必须保持 `ACTIVE` 并提示 `DEEP_VALUE_ALERT`，允许用户随时平仓或加仓。
- 验证证据：注入现价 1200.00（跌幅 -25.0%），检查批次状态仍为 `ACTIVE`，支持执行 `trade lot close` 正常平仓。

### TC-N07: 单标的 30% 仓位硬顶拦截断言 (Position Cap Guard)
- 命题：拟买入标的折算持仓市值占投资组合总市值比例将突破 30.00% 时，系统坚决拦截买入。
- 验证证据：当前总组合 100,000 元，标的已有 25,000 元，尝试再买 10,000 元（占比升至 35%），断言买入命令失败，退出码非 0，提示仓位超限。

### TC-N08: 跨券商账户日内代冲隔离断言 (Cross-Account Isolation Guard)
- 命题：账户 A 持有历史底仓，账户 B 当日买入同标的并盈利，严禁跨账户借用账户 A 的底仓进行日内代冲 T+0 卖出。
- 验证证据：在账户 B 中尝试以底仓代冲方式卖出，系统必须提示 `T1_LOCKED_ALERT` 并拦截卖出。

### TC-N09: 未授权请求严禁泄露账本数据断言 (Token Security Guard)
- 命题：未携带 Token 或携带错误 Token 请求 `trade serve` 受保护接口，返回 401 且响应内容绝不包含账本数据。
- 验证证据：`curl -s -i http://127.0.0.1:8080/api/lots`，断言 HTTP 401，响应体中无任何 symbol、price、lot 等敏感字段。


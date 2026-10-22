# lot-trader 安全清单 (Security & Isolation Checklist)

版本：v1.0.0
负责角色：persona-lot-trader-qa
适用范围：`lot-trader` CLI、本地 SQLite 账本、trade serve HTTP 引擎与单文件 HTML 看板

---

## 1. 账本物理隔离守卫 (Ledger Isolation)
- [ ] **生产账本防触碰**：任何测试、回归演练、E2E 走查或 CI 脚本，严禁直接读写生产账本路径（默认 `~/.trade/trade.db` 或 `$LOT_TRADER_DB`）。
- [ ] **环境变量/参数重定向**：测试运行时必须显式指定 `TRADE_DB_PATH=/tmp/...` 或 `--db /tmp/...`。
- [ ] **清理与防残留**：临时测试生成的 SQLite 文件在用例执行完毕后必须自动释放并安全删除，不占用磁盘空间。

## 2. 本地回环与账本私密性守卫 (Loopback & Privacy)
- [ ] **127.0.0.1 严格绑定**：`trade serve` 只允许监听 `127.0.0.1` 回环地址，严禁监听 `0.0.0.0` 或局域网网卡，确保账本绝对不出本机。
- [ ] **端口冲突优雅提示**：当目标端口被占用时，控制台输出清晰的可读指引文案，严禁抛出未捕获崩溃堆栈。
- [ ] **优雅关机**：接收到 SIGINT 或 SIGTERM 信号后，HTTP 服务优雅关闭连接并清除会话临时文件。

## 3. 会话凭据门禁 (Session Token & File Permissions)
- [ ] **0600 凭证文件权限**：`~/.lot-trader/session.token` 生成时必须设置权限为 `chmod 0600`（仅当前 OS 用户可读写）。
- [ ] **随机性**：每次启动必须随机生成 32 字节（64 字符十六进制）高熵令牌。
- [ ] **401 未授权拦截**：对受保护端点（`/api/summary`、`/api/lots`）发起请求时，若缺少 Token 或 Token 错误，必须严格返回 HTTP 401 `UNAUTHORIZED`。
- [ ] **账本零泄漏**：401 响应体格式必须为纯错误信息（如 `{"error":"UNAUTHORIZED"}`），严禁包含任何账本、账户或持仓数据字段。

## 4. 组合风控与仓位硬顶守卫 (Position Cap Risk Guard)
- [ ] **单标的 30% 仓位硬顶**：单标的拟买入/加仓后占比超过总投资组合 30.00% 时，引擎坚决拦截。
- [ ] **预算不可突破**：满仓金额是绝对不可突破的硬约束，算法中必须有确定性拦截并返回退出码非零。

## 5. 批次生命周期与异常状态守卫 (Lot Lifecycle & Anomaly Alerts)
- [ ] **大跌严禁冻结**：当标的跌幅超过 -20% 时，批次状态严禁变更为冻结或不可交易，必须严格保持 `ACTIVE` 状态。
- [ ] **极度深跌预警**：大跌批次必须标注 `DEEP_VALUE_ALERT`，确保操盘者清晰识别低估区间并支持主动平仓。

## 6. 金字塔加仓防抖守卫 (Lineage & Anti-Shake Cooldown)
- [ ] **48 小时冷却拦截**：同源血缘链在 48 小时内若已发生过加仓，严格拦截频密补仓，防止急跌行情中过快耗尽流动资金。
- [ ] **加仓层级递增**：加仓成功后，子批次必须继承父批次血缘，且 `pyramid_level = parent.pyramid_level + 1`。


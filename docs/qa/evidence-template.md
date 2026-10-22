# lot-trader 可执行证据报告模板 (Executable Evidence Template)

硬性纪律：产出必须是可执行证据，不是代码观感。
严禁写："serve.ts 第 704 行存在风险" 或 "根据代码推测逻辑正确"。
必须写："执行了某命令/触发了某操作，输入载荷为何，观测到具体数值/状态从 X 变为 Y，断言成立/不成立"。

---

## 报告结构示例

### 1. 运行概要
- 检查代码提交：`commit <sha>`
- 运行环境：Bun v1.3.14 (Darwin arm64)
- 门禁判定：**[ PASS 放行 / FAIL 打回 ]**
- 测试沙箱数据库：`/tmp/test-evidence-smoke.db` (已在验收后安全销毁)

### 2. 证据明细记录

#### 证据 1：单二进制构建与基础单元验证
- **执行命令**：`bun test` 与 `bun run build`
- **实测输出**：
  - `bun test`：16 个测试文件全部通过，共包含 68 个测试用例，运行耗时 1.28 秒，失败用例数：0。
  - `bun run build`：输出可执行二进制 `./trade`（文件大小 63,611,234 字节，权限 -rwxr-xr-x）。
- **判定结论**：PASS。

#### 证据 2：48h 金字塔加仓防抖拦截 (TC-N02)
- **前置状态**：
  - 父批次 ID 1（标的 600519.SH，成本 1600.00，股数 100），创建时间：2026-10-22 10:00:00。
  - 当前系统时间：2026-10-22 11:30:00（间隔 1.5 小时，处在 48h 冷却窗口内）。
- **执行动作**：
  ```bash
  ./trade lot add --parent-lot-id 1 --price 1550.00 --db /tmp/test-evidence-smoke.db --json
  ```
- **前后观测对比**：
  - 命令退出码：从正常的 `0` 变为 `1`；
  - 终端响应：返回 `{"error":"LINEAGE_ANTI_SHAKE_COOLDOWN","message":"Parent lot 1 is within 48h cooldown window"}`；
  - 数据库检验：查询 lots 表批次记录，总批次数保持为 `1`，未产生任何子批次记录。
- **判定结论**：PASS（防抖防线确实拦截，流动资金未被过度消耗）。

#### 证据 3：浮盈移动止盈动态激活与回撤警报 (TC-P04 & TC-N05)
- **前置状态**：
  - 批次 ID 1 买入成本 1600.00 元，当前 `trailing_stop_active` 为 `0`，`peak_price` 为 `1600.00`。
- **执行动作 1（注入浮盈 +15.6% 行情）**：
  - 模拟现价推升至 1850.00 元，执行 `./trade stats --db /tmp/test-evidence-smoke.db`。
  - **观测对比**：浮动盈亏从 `0.00 元` 跃升至 `+25,000.00 元`（收益率 +15.63%）；`trailing_stop_active` 由 `0` 变为 `1`，`peak_price` 从 `1600.00` 刷新为 `1850.00`。
- **执行动作 2（自高点回撤 3.2% 模拟）**：
  - 模拟现价下挫至 1790.00 元（自 1850 峰值回撤 60 元，幅度 3.24% > 3% 阈值）。
  - **观测对比**：浮动盈亏从 `+25,000.00 元` 回落至 `+19,000.00 元`；系统即刻输出警报 `[TRAILING_STOP_ALERT] 600519.SH triggered 3% pullback from peak 1850.00, lock-in price 1790.00`。
- **判定结论**：PASS（高位利润锁定机制精准起效）。

#### 证据 4：本地微服务无 Token 访问拦截 (TC-N09)
- **前置状态**：
  - 启动 `./trade serve --port 8088 --db /tmp/test-evidence-smoke.db --token secret_token_xyz` 后台监听。
- **执行动作**：
  ```bash
  curl -s -i http://127.0.0.1:8088/api/lots
  ```
- **前后观测对比**：
  - HTTP 状态码：返回 `HTTP/1.1 401 Unauthorized`；
  - HTTP 响应体：返回 `{"error":"UNAUTHORIZED"}`，字符长度 24 字节；
  - 账本私密性：响应中未出现任何 symbol、price、qty、broker 等真实字段，未授权访问被彻底阻断。
- **判定结论**：PASS。


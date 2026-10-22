# lot-trader 发布门禁 (Release Gate)

版本：v1.0.0
负责角色：persona-lot-trader-qa
触发规则：每次 `trade` 代码库有新提交（commit / PR），或准备发版时，全量跑一遍门禁再放行。

---

## 门禁工作流（Gate Workflow）

```
[新提交 / PR]
       ↓
[Gate 1: 单元与策略测试 100% 通过 (bun test)]
       ↓ (通过)
[Gate 2: 单文件二进制可执行构建 (bun run build -> ./trade)]
       ↓ (通过)
[Gate 3: 沙箱 SQLite 隔离黑盒全生命周期走查]
       ↓ (通过)
[Gate 4: 看板离线自驱 & 本地联动双模冒烟]
       ↓ (通过)
[Gate 5: 负向防误杀守卫全量通过]
       ↓ (通过)
[出具可执行证据报告 -> 判定 PASS 放行 / FAIL 打回]
```

## 关卡详情与放行条件

### Gate 1: 静态与单元基线
- 执行命令：`bun test`
- 放行条件：全部测试用例 100% pass，零失败、零报错。

### Gate 2: 单二进制编译
- 执行命令：`bun run build`
- 放行条件：成功生成 `./trade`，文件大小 > 50MB，具备执行权限，`./trade --help` 退出码为 0。

### Gate 3: 沙箱黑盒全流程走查
- 测试环境：指定 `TRADE_DB_PATH=/tmp/gate-smoke-$$.db`，绝不触碰生产库。
- 走查步骤：
  1. 注册账户：`./trade account add CMB_TEST --name "测试账户" --broker CMB`
  2. 建仓买入：`./trade lot buy 600519.SH --price 1600 --qty 100 --account CMB_TEST`
  3. 防抖加仓拦截：同源在 48h 内执行 `./trade lot add --parent-lot-id 1 --price 1550`，确认必须拦截返回错误码；
  4. 止损/止盈扫描：`./trade stats` 与 `./trade position` 数据结构完整；
  5. 平仓与战绩：`./trade lot close 1 --price 1650 --reason "波段止盈"` 成功更新状态为 CLOSED 并核算出实现收益。

### Gate 4: 单文件看板双模冒烟
- 静态生成：`./trade dashboard --out /tmp/gate-dashboard.html`，检查文件存在且内容包含标的配置与动态脚本。
- 服务探活：`./trade serve --port 8081 --quiet &`，curl 检查 `/api/health` 返回 `{"status":"ok"}`，终止后台服务。

### Gate 5: 负向防误杀守卫 (Negative Anti-False-Positive Guard)
- 详见 `acceptance-cases.md` 中的负向测试集，全部断言成立。

## 打回机制与上报
- 若任一关卡失败，门禁立即阻断，严禁合并或发版。
- 输出「FAIL 门禁打回报告」，附带复现命令、观测到的实际错误流、前后数值差，指派给 `persona-strategy-automator` 修复。


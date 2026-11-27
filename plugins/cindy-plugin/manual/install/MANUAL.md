# lot-trader 引擎安装与排错（给 Agent）

本手册指导你（Agent）帮用户把 **lot-trader 操盘引擎（`trade` CLI）** 装好，并处理常见问题。
本插件只负责把引擎接进 Cindy，**不随包引擎二进制**——引擎必须存在于用户本机。

## 平台支持

- 仅 **macOS / Linux** 的 `arm64` 与 `x64`。**没有 Windows 产物**。
- 用户的系统不是上述四种之一时，直接说明「本插件当前不支持该平台」，不要反复重试。

## 引擎路径解析顺序

插件每次调用都按此顺序找 `trade`（命中的第一个就用）：

1. 设置页里填写的自定义路径（`/kv` 的 `binaryPath`）
2. 环境变量 `$LOT_TRADER_BIN`
3. `~/.local/bin/trade`
4. `~/.lot-trader/bin/trade`
5. `/usr/local/bin/trade`
6. `/opt/homebrew/bin/trade`
7. `PATH` 上的 `trade`

账本路径：`$LOT_TRADER_DB` → `$TRADE_DB_PATH` → `~/.trade/trade.db`。

## 第一步：检查是否已安装

- **首选**：请用户打开「插件 → Lot Trader 操盘引擎 → 设置」，那里会显示「引擎状态：已找到/未找到」和路径。
- 或直接调用 `trade_position`。若返回 `CLI_NOT_FOUND`，说明没装或路径不对。

## 第二步：安装（推荐自动）

请用户打开插件的**设置页**，点 **「一键下载安装引擎」**：

- 插件会识别当前平台，从 GitHub Releases 固定版本 **v0.1.0** 下载对应二进制；
- 下载由宿主完成并**校验 sha256**，然后 Node 工作进程把它复制到 `~/.local/bin/trade` 并 `chmod 755`；
- 设置页会显示进度，装完自动重新检测。

这条路径需要宿主的 `cindy.downloads` 能力；若宿主不支持，设置页会提示，改走下面的手动安装。

## 第二步（备选）：手动安装

1. 打开 https://github.com/Goodfun-Studio/lot-trader/releases
2. 按平台下载对应资产：
   - Apple Silicon（arm64）→ `trade-darwin-arm64`
   - Intel Mac（x64）→ `trade-darwin-x64`
   - Linux arm64 → `trade-linux-arm64`
   - Linux x64 → `trade-linux-x64`
3. 移动到 `~/.local/bin/trade`（目录不存在就先建），并 `chmod 755 ~/.local/bin/trade`
4. 回到设置页点「重新检测」，或用 `trade_position` 验证

> 也可把 `trade` 放在别处，然后在设置页「引擎路径」里填绝对路径并保存，或设 `$LOT_TRADER_BIN`。

## 第三步：验证

调用 `trade_stats` 或 `trade_position`，能返回结构化数据即安装成功。

## 常见问题

- **`CLI_NOT_FOUND`**：引擎没装、不在解析路径、或没有可执行权限。按上面的顺序排查；确认文件 `chmod 755`。
- **收益率看起来「恰好像只有规费」（约 -0.1%）**：引擎在行情取不到时会把现价回落到最近买入价，且不留标记。用 `trade_physics <标的>` 复核：若 `current_price` 为 0 或 `data_bars_count` 为 0，则该收益率不可信。如实告诉用户，别当成真实盈亏。
- **`trade_lot_close` 被拒（法定 T+1）**：当日买入的份额不能直接平仓。若账户有交收底仓，传 `substitute_core: true` 走底仓代冲；且代冲严格限定在同一（标的, 账户）内。
- **`trade_lot_add` 被拒（30% 硬顶或 48h 防抖）**：单标的组合占比超 30% 时引擎强制拦截加仓；同一父亲缘链 48 小时内只允许加仓一次。这是引擎的执行事实，不是报错。
- **看板/工具要拉行情，可能等几十秒**：`trade_position` 会拉全市场行情与历史 K 线，属正常。

## 写操作的边界

买/加/平/记分红/建账户都会**真实写账本**，工具声明了 `approval: each-call`，每次都需要用户确认。不要替用户放行。

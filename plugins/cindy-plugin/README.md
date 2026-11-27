# Lot Trader 操盘引擎（Cindy 插件）

把本机 [lot-trader](https://github.com/Goodfun-Studio/lot-trader) 操盘引擎接进 Cindy：
持仓、批次、信号、战绩、物理雷达等变成 Agent 可直接调用的工具，并提供一个右侧栏持仓看板。

> **本插件只是「壳」**：所有账本语义、风控闸门与计算都在编译好的 `trade` 引擎里。
> 插件不随包引擎二进制，**需要你先在本机安装 lot-trader 引擎**。

## 使用前提

1. **操作系统**：macOS 或 Linux（arm64 / x64）。**暂不支持 Windows**。
2. **已安装 lot-trader 引擎**（可执行文件 `trade`）。

### 安装引擎

**方式一：在 Cindy 里一键安装（推荐）**

打开「插件 → Lot Trader 操盘引擎 → 设置」，点 **「一键下载安装引擎」**。
插件会识别你的平台，从 GitHub Releases 下载固定版本并校验 sha256，装到 `~/.local/bin/trade`。

**方式二：手动安装**

到 [Releases](https://github.com/Goodfun-Studio/lot-trader/releases) 下载对应平台的文件：

| 平台 | 资产 |
| --- | --- |
| Apple Silicon | `trade-darwin-arm64` |
| Intel Mac | `trade-darwin-x64` |
| Linux arm64 | `trade-linux-arm64` |
| Linux x64 | `trade-linux-x64` |

然后：

```bash
mkdir -p ~/.local/bin
# 把下载的文件移动到 ~/.local/bin/trade
chmod 755 ~/.local/bin/trade
```

引擎放在别处也行：在插件设置页填写绝对路径，或设置环境变量 `LOT_TRADER_BIN`。

## 能做什么

**右侧栏看板**：插件启用后，右侧栏会出现「Lot Trader」页签。
组合总览、标的全景卡（含 30% 硬顶告警与物理雷达摘要）、批次的时间维度 / 盈亏率维度双视图、历史战绩。

**Agent 工具**（11 个）：

- 只读：`trade_position`、`trade_lot_list`、`trade_scan`、`trade_stats`、`trade_physics`、`trade_dividend_list`
- 写入：`trade_lot_buy`、`trade_lot_add`、`trade_lot_close`、`trade_dividend_add`、`trade_account_add`

**写入类每次都需要你确认**（`approval: each-call`），不会被一键放行。

**用法**：直接对 Cindy 说「看看我的持仓」「518880 的物理雷达」「复盘最近战绩」，或用 `$操盘 <内容>` 点名。

## 账本位置

`$LOT_TRADER_DB` → `$TRADE_DB_PATH` → `~/.trade/trade.db`。数据完全留在本机。

## 已知说明

- 引擎在行情取不到时会把现价回落到最近买入价且不留标记，此时展示的收益率可能是算出来的
  （典型特征：恰好只剩规费，约 -0.1%）。要复核就跑一次 `trade_physics <标的>`。
- 仓位条用的是**组合占比**（与 30% 硬顶同口径），不是引擎默认满仓额口径。
- 首次打开看板要拉全市场行情，可能等几秒到几十秒。

## 从本仓库开发 / 打包

本目录是 Cindy 插件的**源码**：`ghost.json`（身份卡 + 工具声明）、`main.js`（沙箱电子脑）、
`node/worker.cjs`（随包 Node 工作进程，负责拼 `trade` argv）、`panel.*`（右侧栏看板）、
`settings.*`（设置页）、`manual/install/MANUAL.md`（给 Agent 的安装引导）。

- 打包与安装由 **Cindy** 完成：在 Cindy 里对 `plugins/cindy-plugin/` 调用 `ghost_forge_pack` 生成 `.cindy`，
  再用 `ghost_forge_install` 安装；或把生成的 `.cindy` 文件拖进 Cindy。
- `*.cindy` 是构建产物，已在仓库 `.gitignore` 中忽略。
- 插件自身版本见 `ghost.json` 的 `version`；一键安装锁定的引擎发行版本见 `main.js` 的 `ENGINE_ASSETS`
  （含逐平台 URL、字节数与 sha256）。升级引擎发行版时同步更新这里的固定值。

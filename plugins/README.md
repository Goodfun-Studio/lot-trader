# 插件端口（Plugins）

本仓库的主体是 **lot-trader 引擎**（`src/`、编译产物 `trade`、`SKILL.md` / `MANUAL.md`）。
下面的「插件」是把它接到不同 AI 宿主的**外壳**：引擎一行没动，插件只负责把引擎已有的契约
（读命令、写命令、操盘纪律、持仓看板）端到模型和用户面前。

## 目录约定

- **`plugins/<harness>-plugin/`** —— 其它宿主的插件端口统一放这里，各自自带 README、LICENSE 与源码。
- **`dsh-plugin/`（仓库根目录，冻结）** —— DeepSeek Harness 端口，**已发布到 DSH 开放插件市场**，
  位置与内容保持不动，以免破坏市场身份与已发布版本。它不随本目录的约定迁移。

## 现有端口

| 端口 | 宿主 | 位置 | 状态 |
| --- | --- | --- | --- |
| dsh-plugin | DeepSeek Harness (DSH) | [`../dsh-plugin/`](../dsh-plugin) | 已上架 DSH 开放插件市场（冻结，勿动） |
| cindy-plugin | Cindy | [`cindy-plugin/`](./cindy-plugin) | 已合并进 `main`，未上架 |

## 新增一个宿主端口

1. 在 `plugins/` 下新建 `<harness>-plugin/` 目录。
2. Agent 侧说明以仓库根部的 `SKILL.md` / `MANUAL.md` 为单一来源，按宿主格式转换，**不要**另起一套互相漂移的规则。
3. 自带 `README.md`（安装 / 使用 / 平台支持 / 已知问题）与 `LICENSE`（MIT）。
4. 写清引擎依赖：端口**不随包引擎二进制**；引擎是 macOS / Linux 的独立可执行文件（见根 README）。
5. 写操作必须在宿主层挂审批闸门，不得绕过。

> 各宿主的插件格式互不相同（DSH 用 npm + Cordis；Cindy 用 `.cindy` / `ghost.json`）。
> 能在端口之间共用的是**引擎契约与文档**，不是插件源码。

# 贡献指南

感谢你对 lot-trader 的兴趣！本项目目前处于个人维护阶段。

## 📋 当前状态

- **维护者**：[@ivywu](https://github.com/ivywu)
- **许可证**：MIT
- **开发进度**：Alpha 阶段

## 🔄 工作流程

本项目当前采用以下工作流：

```
Feature Branch → Pull Request → Code Review → Main
                  (1 approval required)
```

## 🚀 开发设置

### 前置要求

- [Bun](https://bun.sh/) >= 1.0.0
- Python 3.8+ (用于 dashboard 生成)
- Git

### 本地开发

```bash
# 克隆仓库
git clone https://github.com/Goodfun-Studio/lot-trader.git
cd lot-trader

# 安装依赖
bun install

# 运行测试
bun test

# 本地开发
bun run src/cli.ts lot --help
```

### 构建二进制

```bash
bun run build

# 压缩二进制（可选）
upx --best --lzma trade
```

## 📝 提交指南

### 分支命名

```
feature/xxx        # 新功能
bugfix/xxx         # Bug 修复
docs/xxx           # 文档
refactor/xxx       # 重构
test/xxx           # 测试
```

### Commit 消息格式

遵循 [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Type**:
- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档
- `style`: 代码风格（不影响功能）
- `refactor`: 代码重构
- `perf`: 性能优化
- `test`: 测试
- `chore`: 构建/依赖等

**例子**:
```
feat(lot): add pyramid level auto-calculation

Add automatic pyramid level calculation based on parent lot hierarchy.
This simplifies user workflow for multi-level pyramid purchases.

Closes #42
```

## 🧪 测试

```bash
# 运行全量测试
bun test

# 特定文件测试
bun test src/engine.test.ts

# Watch 模式
bun test --watch
```

### 测试覆盖

- 核心业务逻辑：100% 覆盖
- CLI 命令：关键路径覆盖
- 错误处理：边界情况和异常场景

## 📚 代码规范

### TypeScript

- 严格模式（tsconfig.json 已配置）
- 无 `any` 类型（除非有特殊理由）
- 明确的错误类型定义

### 文件结构

```
src/
├── cli.ts           # 命令行入口
├── engine.ts        # 核心业务逻辑
├── db.ts            # 数据库层
├── position.ts      # 持仓计算
├── scanner.ts       # 信号扫描
├── physics.ts       # 物理动量雷达
└── *.ts             # 其他模块
```

## 🔍 PR 审核标准

- ✅ 代码通过测试
- ✅ 无重大安全问题
- ✅ 符合代码规范
- ✅ 文档已更新
- ✅ 提交信息清晰

## 📖 文档

- **MANUAL.md** - 完整使用手册
- **SKILL.md** - AI Agent 技能描述
- **README.md** - 快速开始

## ❓ 问题反馈

- 使用 [GitHub Issues](https://github.com/Goodfun-Studio/lot-trader/issues) 报告 Bug
- 标签分类：`bug`, `enhancement`, `documentation`, `question`

## 📄 许可证

本项目采用 MIT 许可证。详见 [LICENSE](LICENSE)

---

**开发快乐！** 🎉

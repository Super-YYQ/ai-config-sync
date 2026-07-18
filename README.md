# AI Agent Config Sync

程序仓库 + 私有配置仓库 + Claude Code / Codex 智能入口

**设计原则：** 自动发现，人工纳管；AI 负责理解，程序负责确定性执行；配置进入私有仓库，密钥与运行状态留在本机。

文档状态：M0/M1 + M2 核心能力（TypeScript monorepo）  
版本：0.2.0

## 这是什么

在多台电脑、多个 AI 编程工具之间，管理用户级 **Skill / Plugin / Hook / MCP / 指令文件** 及其安装来源。

系统**不**复制整个工具目录，也**不**做字节级镜像，而是把「期望能力」结构化保存，在新设备上通过工具原生机制重新安装并验证。

| 数据层 | 内容 |
|--------|------|
| 通用程序仓库（本仓库） | 扫描器、CLI、适配器、Schema、Claude Plugin、Codex 集成 |
| 个人私有配置仓库 | 资源清单、配方、Profile、自定义源码 |
| 本机状态 | `~/.ai-config-sync/`：密钥引用解析、state、备份、pending events |

## 快速开始

### 要求

- Node.js ≥ 18
- Git
- Windows 优先（macOS/Linux 路径接口已保留）

### 安装（开发）

```bash
cd ai-config-sync
npm install
npm run build
npm test
```

全局试用 CLI：

```bash
npm link -w @ai-config-sync/cli
# 或
npx tsx packages/cli/src/index.ts --help
```

### 第一台电脑

```bash
# 1. 准备私有配置仓库（可用模板）
cp -r examples/yyq-ai-config-template D:/Git/yyq-ai-config
cd D:/Git/yyq-ai-config && git init && git add . && git commit -m "init"

# 2. 幂等 setup
npx ai-config-sync setup --config-path D:/Git/yyq-ai-config --profile home

# 3. 查看计划并应用（demo-skill 会分别装到 Claude 与 Codex）
npx ai-config-sync plan
npx ai-config-sync apply --yes --allow-risk medium
npx ai-config-sync doctor
```

### 第二台电脑

```bash
npx ai-config-sync setup --repo git@github.com:you/yyq-ai-config.git --profile company
npx ai-config-sync plan
npx ai-config-sync restore --yes --allow-risk medium
npx ai-config-sync doctor
```

### 离线示例：vendored planning-with-files

模板内置双工具离线快照（无需 GitHub / Claude CLI）：

```bash
npm run build
npm run demo:offline-pwf
# 保留临时 HOME 便于查看：
npx tsx scripts/demo-offline-pwf.ts --keep
```

会在隔离 HOME 中：

1. `setup --profile offline-demo`
2. `apply --offline` → Claude skill + Codex skill/hooks/`features.hooks`
3. 二次 apply → `SKIP`
4. 打印 `drift` / `doctor` 与关键文件内容

## CLI

| 命令 | 说明 |
|------|------|
| `setup` | 初始化 / 关联 / 修复 / 重配（幂等） |
| `status` | 仓库、Profile、pending |
| `scan` | 只读扫描 |
| `capture` | 本机变化纳入私有仓库 |
| `plan` | 显示将要执行的操作 |
| `apply` / `restore` | 执行 Plan（需 `--yes`，高风险需 `--allow-risk`） |
| `update` | 按 versionPolicy 更新 |
| `doctor` | 依赖、Git 安全、Hook、安装状态 |
| `drift` | 期望 vs 本机 |
| `repair` | 补齐入口 |
| `rollback` | 从备份恢复 |
| `secret` | Secret 引用检查说明 |

## 仓库结构

```
ai-config-sync/
├─ packages/
│  ├─ core/            # Schema、合并、密钥扫描、路径
│  ├─ scanner/         # 本机 Skill/Plugin/Hook 扫描
│  ├─ recipe-engine/   # 规则分析、Plan/Apply、Capture、Doctor
│  ├─ state-manager/   # state、backup、pending
│  ├─ git-sync/        # 安全 Pull/Push/Commit
│  └─ cli/             # ai-config-sync / agent-sync
├─ drivers/            # generic-skill / claude-marketplace / repository-layout / npx-skills
├─ integrations/
│  ├─ claude-plugin/   # Plugin + skills + hooks + commands
│  └─ codex/           # Skill + hooks
├─ examples/yyq-ai-config-template/
├─ schemas/
├─ tests/
└─ docs/
```

## 安全边界

- Secret 仅允许 `secretRef`；提交前扫描 `ghp_` / `sk-` / 私钥头等
- 脏工作区或 Git 分叉时**禁止**自动 Pull/Push
- Apply 前备份受影响路径；`rollback --last`
- AI（若启用）只生成候选配方，**不能**直接 Apply
- `run-cli` 受命令白名单约束；`high` 风险默认拒绝

## MVP 验收对照

- [x] setup 关联已有仓库，不重复 Clone
- [x] 普通 Skill 分别部署到 Claude / Codex 独立目录
- [x] planning-with-files 类双配方模型（marketplace + repository-layout）
- [x] Plan → Apply，Apply 前备份
- [x] JSON/TOML 字段级合并，不整文件覆盖
- [x] 重复 setup/apply 幂等
- [x] 未提交修改 / 分叉时不自动同步
- [x] Secret 扫描阻止提交
- [x] 已确认配方 restore 不依赖 AI
- [x] Doctor 报告依赖与配置问题
- [x] Claude Plugin / Codex Skill 入口与 SessionStart 轻量 scan

## 开发里程碑（文档 §19）

| 阶段 | 状态 |
|------|------|
| M0 原型 setup/scan/skill/plan | 已实现 |
| M1 Plugin/Codex/合并/备份 | 已实现（Plugin CLI 不可用时降级 MANUAL） |
| M2 Source cache / Drift / Secret / AI analyze-only / Markdown merge | 已实现（LLM provider 可插拔，默认 heuristic） |
| M3 MCP / 计划任务 / Bitwarden·KeePassXC | 未做 |

### M2 补充能力

- **Source cache**：GitHub 来源克隆到 `~/.ai-config-sync/cache/sources/`，支持 `locked` commit 与 `--offline`
- **Drift**：`ai-config-sync drift` 基于目录哈希对比期望与本机
- **幂等 apply**：已安装且 in-sync 的 Skill 输出 `SKIP` / `No changes`
- **Secret**：`secret check|scan`，Doctor 检查 `secretRef`（仅 env 提供方）
- **AI analyze-only**：`capture --ai` 或 `ai.mode: analyze-only`；只生成候选配方
- **Markdown 托管区块**：`mergeManagedMarkdown` 用于 CLAUDE.md / AGENTS.md

## 许可证

MIT

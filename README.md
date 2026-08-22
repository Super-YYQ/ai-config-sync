# AI Agent Config Sync

在 **Claude Code / Codex** 中扫描、确认和备份 Skill、Plugin、Hook，并从私有 Git 仓库确定性恢复另一台电脑。

<p align="center">
  <strong>电脑 A：扫描与确认　→　私有配置仓库：可审计资产真源　→　电脑 B：无 AI 恢复</strong>
</p>

> **状态：v0.5.0 Public Beta**
> Claude Plugin 已内置 CLI（无需单独 `npm i -g` 也可在插件 PATH 中调用）。  
> npm 包使用打包后的单文件 `dist/ai-config-sync.cjs`。  
> 本版完成 5 项 P0 安全加固（Plan 快照确认、配置仓写锁、Source Resolver 加固、Skill 原子部署、配置字段策略）+ Apply 锁 + 完整 release:check。  
> 当前 main 已加入私有仓库只读资产目录：GitHub 原生 `ASSETS.md` + 自包含 `catalog/index.html`。
> CI：Node 18/20/22/24 单测 + 跨平台集成/E2E + 覆盖率门槛 + 隔离 tarball Smoke。
> **真实 Claude Code / Codex E2E 仍未覆盖** — 请先在隔离 HOME / 测试环境验证，再用于公司真机。  
> 跨电脑继续开发：见 [`docs/DEVELOPMENT_CHECKPOINT.md`](docs/DEVELOPMENT_CHECKPOINT.md)。  
> 后续主题：Target Adapter、Source Provider、项目级 Skill 与更完整的 Drift。

---

## 这是什么

| 仓库 | 作用 |
|------|------|
| **程序** `ai-config-sync` | 插件 + CLI |
| **私有配置**（你自己的 Git 仓） | 装了啥、怎么装（无密钥） |

日常：扫描 → 备份（capture）→ 另一台电脑恢复（restore）。

---

## 整体产品形态

<p align="center">
  <img src="docs/assets/product-concept-map.svg" width="1180" alt="AI Config Sync 整体产品形态" />
</p>

- **电脑 A**：规则优先扫描；只有 `NEEDS-REVIEW` 可选择 AI 辅助分析，最终由用户确认。
- **私有仓库**：Resources、Profiles、Recipes、Lock 与 vendored Sources 是声明式真源；不存明文密钥、登录态或聊天记录。
- **仓库查看面**：`ASSETS.md` 零部署查看，HTML 提供卡片、搜索和筛选；Capture 会附带生成 `.github/workflows/ai-config-sync-pages.yml`，在 GitHub 仓库设置中把 Pages Source 选为 GitHub Actions 后，每次 push 自动把自包含的 `catalog/` 页面部署为可搜索的站点（仅发布 catalog，不暴露仓库其余内容）。
- **电脑 B**：安装前先显示 Plan，冲突和高风险动作由用户决定，恢复引擎不调用 AI。

完整目标、当前差距和验收标准见 [`docs/PRODUCT_VISION.md`](docs/PRODUCT_VISION.md)。

### A → B 备份与恢复流程

<p align="center">
  <img src="docs/assets/backup-restore-flow.svg" width="1320" alt="从电脑 A 备份到电脑 B 恢复的流程" />
</p>

图中标注“目标”的自动创建私有远端、跨平台双击启动器和资产级冲突中心尚未完成；当前恢复仍需先安装 CLI、关联仓库并显式执行 `plan` / `restore`。

---

## 快速开始

### Claude Code（推荐）

```text
/plugin marketplace add Super-YYQ/ai-config-sync
/plugin install ai-config-sync@ai-config-sync
```

新开会话后：

```text
/ai-config-sync:scan
/ai-config-sync:status
```

插件内含 `bin/ai-config-sync`，**SessionStart 不再调用 `npx`**。

首次备份前关联私有仓（对话「初始化配置同步」或）：

```bash
ai-config-sync setup --config-path ~/ai-config/my-ai-config --profile home
```

扫描、确认并备份后，Capture 会同步刷新仓库的资产目录：

```bash
ai-config-sync scan
ai-config-sync capture
ai-config-sync capture --yes --commit --push
```

### Codex

> Codex Hook 支持为**实验性**：不同 CLI / App / IDE 版本行为可能不同。  
> 已验证路径：本机 `ai-config-sync` CLI + `~/.codex/hooks.json` event-map + `features.hooks=true`。

1. 安装 CLI（任选其一，**不要**假定 Claude Plugin bin 会自动进入 Codex PATH）：  
   - `npm i -g ai-config-sync`（发布后）  
   - 或 `npx ai-config-sync ...`  
   - 或源码 `npm run build` 后把 `dist/` 加入 PATH  
2. `ai-config-sync setup --config-path ...`  
   - 写入 `~/.agents/skills/config-sync`  
   - 写入 Codex **event-map** `hooks.json`（含 Windows `commandWindows` 绝对路径）+ `features.hooks = true`  
3. 对话说：「扫描技能」「备份配置」「恢复环境」

### npm CLI

```bash
# 源码
git clone https://github.com/Super-YYQ/ai-config-sync.git
cd ai-config-sync && npm install && npm run build
node dist/ai-config-sync.cjs --version

# 发布后（若已 publish）
npx ai-config-sync --help
```

干净环境验证：`npm run smoke:npm`

---

## 私有仓库资产目录

每个新建或已关联的私有配置仓库都可以生成：

- `ASSETS.md`：GitHub/GitLab 原生渲染；
- `catalog/index.html`：不依赖后端或 CDN，支持名称搜索与 Kind、Target、Profile 筛选。

<p align="center">
  <img src="docs/assets/catalog-preview.png" width="1120" alt="私有配置仓库资产目录预览" />
</p>

```bash
# 只读查看，不写仓库
ai-config-sync inventory

# 为已关联仓库生成或刷新两个视图
ai-config-sync inventory --write

# 为已有配置仓库生成
ai-config-sync inventory --config-path /path/to/my-ai-config --write
```

目录只展示**已经 Capture 进入仓库**的资产；尚未确认的 scan 结果不会被误标为已备份。详细说明见 [`docs/ASSET_CATALOG.md`](docs/ASSET_CATALOG.md)。

---

## 支持矩阵

| 能力 | Claude | Codex | 状态 |
|------|--------|-------|------|
| 用户级 Skill | ✓ | ✓（优先 `~/.agents/skills`） | 可用 |
| Marketplace Plugin | ✓ | n/a | 可用 |
| SessionStart 轻量扫描 | ✓（插件 bin） | ✓（hooks + features.hooks） | 可用 |
| 私有仓 capture/restore | ✓ | ✓ | 可用 |
| `ASSETS.md` + HTML 仓库目录 | ✓ | ✓ | 可用 |
| MCP / Instruction | — | — | 未实现 |
| 完整外部安装事务补偿 | 部分 | 部分 | 文件回滚已有 |

---

## Marketplace 装的东西怎么同步？

记 **安装方式**（`claude-marketplace` 配方），不是拷贝 cache。  
新电脑：`marketplace add` → `install` → `enable`。  
自身 `ai-config-sync` / `config-sync` **不会**被备份。

---

## 安全

- 默认只读扫描；所有实际 Apply/Restore 写入都必须先查看 Plan 并显式传入 `--yes`
- Plan 会校验配置仓 HEAD、未提交配置改动、完整 Profile 继承链、Recipe 与锁定来源，过期 Plan 拒绝执行
- Copy-based Skill 目标默认 NoClobber；未纳管同名目录或 Plan 后发生的目标变化会阻止 Apply
- Capture、Commit、Push 共享同一配置仓锁；并发状态写入与 Apply 也会串行化
- Apply 硬失败 **自动 rollback**（删新建 + 还原快照）  
- 不同步 OAuth、聊天记录、明文密钥  

---

## Known Limitations

- 仓库内隔离 HOME 的 Setup/Capture/Restore/Rollback 已进 CI；真实已登录 Claude/Codex 客户端冒烟仍需手动执行
- Codex Hook 可能需用户首次信任（实验性）  
- 外部 `claude plugin` 安装的补偿卸载仍有限  
- 非标准仓库：用 `capture --analyze` 启发式分析；`--ai` 仅为别名，真实 LLM 需配置 provider  
- Capture 提案状态：`READY` / `BLOCKED` / `NEEDS-REVIEW`；`--yes` 只写入 READY  
- 尚未自动创建远端私有仓库；目前需提供本地路径或现有 Git remote
- 尚无仓库内跨平台双击恢复启动器，B 机仍需安装可信 CLI
- Git 目前使用 fast-forward-only 拉取，尚无资产级三选一冲突中心

---

## 开发

```bash
npm install && npm run build   # includes plugin CLI bundle
npm test
npm run test:coverage
npm run demo:offline-pwf       # uses examples/demo-config
npm run smoke:npm
```

- 空用户模板：`examples/private-config-template/`  
- 演示数据：`examples/demo-config/`  
- 资产目录设计：`docs/ASSET_CATALOG.md`
- 已确认产品目标：`docs/PRODUCT_VISION.md`
- Skills Manager 对比与取舍：`docs/SKILLS_MANAGER_LEARNINGS.md`
- 变更：`CHANGELOG.md`  
- 计划基线：v0.5 Public Beta（见 `ROADMAP.md`）

MIT · v0.5.0

# AI Agent Config Sync

在 **Claude Code / Codex** 中管理 Skill、Plugin，并同步到私有 Git 仓库。

> **状态：v0.4.0 Alpha Hardening**  
> Claude Plugin 已内置 CLI（无需单独 `npm i -g` 也可在插件 PATH 中调用）。  
> npm 包使用打包后的单文件 `dist/ai-config-sync.cjs`。  
> 请先在隔离 HOME / 测试环境验证，再用于公司真机。

---

## 这是什么

| 仓库 | 作用 |
|------|------|
| **程序** `ai-config-sync` | 插件 + CLI |
| **私有配置**（你自己的 Git 仓） | 装了啥、怎么装（无密钥） |

日常：扫描 → 备份（capture）→ 另一台电脑恢复（restore）。

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

### Codex

1. 安装 CLI（插件 PATH、或 `npm i -g`、或源码 build）  
2. `ai-config-sync setup --config-path ...`  
   - 写入 `~/.agents/skills/config-sync`  
   - 写入 Codex **event-map** `hooks.json` + `features.hooks = true`  
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

## 支持矩阵

| 能力 | Claude | Codex | 状态 |
|------|--------|-------|------|
| 用户级 Skill | ✓ | ✓（优先 `~/.agents/skills`） | 可用 |
| Marketplace Plugin | ✓ | n/a | 可用 |
| SessionStart 轻量扫描 | ✓（插件 bin） | ✓（hooks + features.hooks） | 可用 |
| 私有仓 capture/restore | ✓ | ✓ | 可用 |
| MCP / Instruction | — | — | 未实现 |
| 完整外部安装事务补偿 | 部分 | 部分 | 文件回滚已有 |

---

## Marketplace 装的东西怎么同步？

记 **安装方式**（`claude-marketplace` 配方），不是拷贝 cache。  
新电脑：`marketplace add` → `install` → `enable`。  
自身 `ai-config-sync` / `config-sync` **不会**被备份。

---

## 安全

- 默认只读扫描；写操作需 Plan / 确认  
- Apply 硬失败 **自动 rollback**（删新建 + 还原快照）  
- 不同步 OAuth、聊天记录、明文密钥  

---

## Known Limitations

- Alpha：跨平台矩阵未完整 CI  
- Codex Hook 可能需用户首次信任  
- 外部 `claude plugin` 安装的补偿卸载仍有限  
- 非标准仓库自动配方不能保证 100%  

---

## 开发

```bash
npm install && npm run build   # includes plugin CLI bundle
npm test
npm run demo:offline-pwf       # uses examples/demo-config
npm run smoke:npm
```

- 空用户模板：`examples/private-config-template/`  
- 演示数据：`examples/demo-config/`  
- 变更：`CHANGELOG.md`  
- 计划基线：v0.3 Alpha Hardening（审查2 + 后续优化计划）

MIT · v0.4.0

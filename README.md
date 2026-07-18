# AI Agent Config Sync

在 **Claude Code / Codex 对话里** 管理 Skill、Plugin，并同步到你的私有 Git 仓库。

> 日常：说话或斜杠命令。终端命令用于安装与排错。

---

## 这是什么？

换电脑时不用再回忆「装过哪些 Skill / Plugin」。

1. **扫描**本机  
2. **备份**到私有配置仓库（清单 + 安装方式，不含密钥）  
3. **恢复**到另一台电脑  

```
Claude Code 对话          Codex 对话
   斜杠 / 自然语言          Skill / 自然语言
         \                   /
          \                 /
           ▼               ▼
            ai-config-sync CLI
           /               \
   ~/.claude                ~/.codex
           \               /
         私有配置仓库（Git，建议 private）
```

| 仓库 | 作用 | 可见性 |
|------|------|--------|
| **程序** `ai-config-sync` | 插件 + CLI | 可公开 |
| **私有配置**（如 `my-ai-config`） | 你的清单 | **建议 private** |

---

## 安装

### A. 一条命令（发布后）

```bash
npx ai-config-sync@latest --help
# 或全局
npm install -g ai-config-sync
ai-config-sync --version
```

> 当前 monorepo 已支持 `npm pack` / 发布到 npm。若尚未 publish，用 B。

### B. 从源码

```bash
git clone https://github.com/Super-YYQ/ai-config-sync.git
cd ai-config-sync
npm install && npm run build
npm link -w @ai-config-sync/cli
```

### C. Claude Code 在线插件（与其它插件相同）

```text
/plugin marketplace add Super-YYQ/ai-config-sync
/plugin install ai-config-sync@ai-config-sync
```

或：

```bash
claude plugin marketplace add Super-YYQ/ai-config-sync
claude plugin install ai-config-sync@ai-config-sync
claude plugin enable ai-config-sync@ai-config-sync
```

**新开 Claude 会话** 后，`/` 搜索 `ai-config-sync`。

### D. Codex 怎么用？

Codex **没有**和 Claude 完全一样的「斜杠命令市场」，入口是 **用户级 Skill + Hook**：

1. 安装 CLI 后执行一次 setup（会写入 Codex 入口）：
   ```bash
   ai-config-sync setup --config-path ~/ai-config/my-ai-config --profile home
   ```
2. setup 会安装：
   - `~/.codex/skills/config-sync/SKILL.md`（对话里说「同步配置」「扫描技能」）
   - `~/.codex/hooks.json` 里的 SessionStart 轻量扫描
3. 在 Codex 里直接说：
   - 「扫描本机 skill」
   - 「备份配置到私有仓库」
   - 「按 home profile 恢复环境」
4. 或让 Codex 执行 shell：
   ```bash
   ai-config-sync scan
   ai-config-sync capture
   ai-config-sync restore --yes --allow-risk medium
   ```

Claude 用 Plugin 斜杠；Codex 用 Skill + CLI——**同一套私有配置仓库**。

---

## Marketplace 装的 Skill 怎么同步？

Claude 里通过 **Marketplace / Plugin** 装的能力，**不是**简单复制 `~/.claude/skills` 目录。

正确模型：

| 本机形态 | 同步时记什么 | 另一台电脑怎么恢复 |
|----------|--------------|--------------------|
| Marketplace 缓存 + 已启用 Plugin | `driver: claude-marketplace` + marketplace 仓库 + plugin 名 | `claude plugin marketplace add` → `install` → `enable` |
| 独立 Skill 目录（复制/vendored） | `driver: generic-skill` + 源路径/仓库 | 复制到 `~/.claude/skills/<id>` |
| Codex 专用目录 + hooks | `driver: repository-layout` | 复制 skill + 合并 hooks.json + config.toml |

流程：

1. 扫描会识别 `~/.claude/plugins/marketplaces/<name>`（读 git remote 推断 GitHub 源）  
2. Capture 对这类资源生成 **claude-marketplace** 配方（不是把 cache 当源码拷进私有仓）  
3. Restore 在新电脑上走官方 Plugin CLI 重装  

自身插件 `ai-config-sync` / `config-sync` **不会**被同步（已排除）。

---

## 私有配置仓库何时配置？

| 操作 | 要不要私有仓 |
|------|----------------|
| 只扫描 | 不要 |
| 备份 capture | **要** |
| 恢复 restore | **要** |

对话：「帮我初始化配置同步」或：

```bash
ai-config-sync setup --config-path ~/ai-config/my-ai-config --profile home
# 或
ai-config-sync setup --repo git@github.com:你/my-ai-config.git --profile home
```

---

## 没有私有仓时扫描？

**可以**，只读本机，提示尚未关联；不会写 Git。  
`capture` / `restore` 会说明需先 setup。

---

## 日常（对话优先）

### Claude Code

| 你做 | 效果 |
|------|------|
| `/ai-config-sync:scan` 或「扫描配置」 | 看本机 |
| `/ai-config-sync:capture` 或「同步到仓库」 | 备份 |
| `/ai-config-sync:restore` 或「恢复环境」 | 恢复 |
| `/ai-config-sync:doctor` | 体检 |

### Codex

| 你做 | 效果 |
|------|------|
| 说「扫描技能」 | 走 config-sync Skill → CLI scan |
| 说「备份配置」 | capture |
| 说「恢复 home 配置」 | restore |
| SessionStart | 轻量扫描，提示未纳管资源 |

---

## 安全与回滚

- Apply 前写入事务备份（`~/.ai-config-sync/backups/`）  
- **硬失败会自动 rollback**（删除新建路径 + 还原修改前快照）  
- 也可：`ai-config-sync rollback --last`  
- 不迁移 OAuth / 聊天记录 / 明文密钥  

---

## 排错

| 现象 | 处理 |
|------|------|
| Claude `/` 无命令 | 新会话；`claude plugin enable ai-config-sync@ai-config-sync` |
| Codex 无反应 | `ai-config-sync repair`；确认 `~/.codex/skills/config-sync` |
| CLI 找不到 | `npm i -g ai-config-sync` 或源码 `npm link` |
| capture 说未关联 | 先 setup 私有仓 |

---

## 开发

```bash
npm install && npm run build && npm test
npm run demo:offline-pwf
npm run pack:check   # 检查可发布文件列表
```

- 设计文档：`docs/AI_Agent_Config_Sync_Design_Development_v1.0.docx`  
- 用户说明：`docs/USER_GUIDE.md`  
- 模板：`examples/private-config-template/`  

版本 **0.2.2** · MIT

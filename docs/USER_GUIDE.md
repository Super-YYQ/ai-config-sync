# 使用说明

## 第一台电脑：初始化

1. **安装程序**
   - Claude Code：`/plugin marketplace add Super-YYQ/ai-config-sync` → `/plugin install ai-config-sync@ai-config-sync` → **新开会话**
   - 或 npm / 源码 CLI（Codex 与无插件场景）
2. **准备私有配置仓**（空模板可复制 `examples/private-config-template`）
3. **关联**

```bash
ai-config-sync setup --config-path ~/ai-config/my-ai-config --profile home
```

或在 Claude 对话说「初始化配置同步」。

4. **扫描 → 备份**

```bash
ai-config-sync scan
ai-config-sync capture --analyze          # 启发式分析未知布局
ai-config-sync capture --yes              # 只写入 READY 提案
ai-config-sync capture --yes --commit     # 可选：secret-scan 后 git commit
ai-config-sync capture --yes --commit --push  # 写入、提交、推送在同一把锁内完成
```

### Capture 提案状态

| 状态 | 含义 | `--yes` 是否写入 |
|------|------|------------------|
| **READY** | 来源已解析，配方可用 | 是 |
| **BLOCKED** | 如 Marketplace 未解析 / 系统资源 | 否 |
| **NEEDS-REVIEW** | 需人工或 `--analyze` | 否 |
| **SYSTEM-EXCLUDED** | 如 Codex `.system` | 否（扫描层已排除） |

`--ai` 是 `--analyze` 的别名；**默认不调用真实 LLM**。只有配置了 `localConfig.ai` provider 时才可能走模型。

启用 Hook 后，SessionStart 会自动轻量扫描并把未纳管资源写成
`pending-review` 待确认项。这个默认流程不会自动 capture、commit 或 push；
源仓库识别不明确的资源仍保持 `NEEDS-REVIEW`，由用户确认处理方式。

## 第二台电脑：恢复

第二台电脑无需再次用 AI 分析，也不要求先安装 Skill / Plugin。只需 Node.js 与
独立 CLI；Skill / Plugin 是进入 AI 工具后的可选入口。

### 本地 Web 页面（推荐）

```bash
npx ai-config-sync ui
```

浏览器页面仅监听 `127.0.0.1`。输入一次私有仓库地址，确认目标与 Profile，
查看 Plan 后点击一次确认。Windows 全局安装后，也可双击 npm 包中的
`AI Config Sync.cmd` 启动页面。

### CLI

一条命令完成连接、Plan 与确认：

```bash
ai-config-sync bootstrap --repo git@github.com:you/my-ai-config.git --profile home
```

交互终端会显示 Plan 后询问；无人值守场景必须显式加 `--yes`。也可以沿用分步
命令：

1. Clone 私有仓，或：

```bash
ai-config-sync setup --repo git@github.com:you/my-ai-config.git --config-path ~/ai-config/my-ai-config
```

2. 预览并应用：

```bash
ai-config-sync plan
ai-config-sync restore --yes --allow-risk medium
```

Marketplace 类资源会走 `claude plugin marketplace add / install / enable`，**不会**手改 Claude 内部状态文件。

## Profile

- `home` / `company` 等在私有仓 `profiles/*.yaml` 中定义
- `extends` 支持多层继承；循环、缺失父 Profile、文件名与 `profile:` 身份不一致会直接报错
- 公司机可用更严格 profile，排除个人 skill
- `setup --profile company` 切换；资源的 `profiles` 字段控制是否纳入

## Git 冲突

- 私有仓请正常用 git：一端 push，另一端 pull 后再 capture/restore
- `capture --commit` 会做 secret-scan；冲突时先 `git pull --rebase` 再操作
- 不要把 `.env`、密钥、OAuth 写进私有仓

## Hook Trust

- **Claude**：SessionStart 使用插件内 `bin/ai-config-sync.cjs`（优先于全局 PATH）
- **Codex**：`~/.codex/hooks.json` event-map + `features.hooks=true`；首次可能提示信任 Hook  
  Windows 会尽量写入 `commandWindows` 绝对路径。Codex Hook 为实验性支持。

## 回滚

- Apply 硬失败会自动 rollback（文件快照 + 尽量补偿本次新装 Plugin）
- 手动：`ai-config-sync rollback --last`
- Capture 写入使用临时目录 + 备份 + 替换；失败会尝试从 `.ai-config-sync-backup-*` 恢复

## Claude Code 快捷命令

```text
/ai-config-sync:scan
/ai-config-sync:capture
/ai-config-sync:restore
/ai-config-sync:status
```

插件已内置 CLI，无需先 `npm i -g`（仍可选用 npm 全局 CLI）。

## Codex

1. 确保 `ai-config-sync` 在 PATH（**npm / npx / 源码 dist**，不要依赖 Claude Plugin bin 自动进 Codex PATH）  
2. `ai-config-sync setup --config-path <私有仓> --profile home`  
3. Skill：`~/.agents/skills/config-sync`  
4. Hook：`~/.codex/hooks.json` + `features.hooks=true`  
5. 对话：「扫描技能」「备份配置」「恢复环境」

## 私有仓

- 空模板：`examples/private-config-template`（默认无演示资源）  
- 演示：`examples/demo-config`  

`scan` 无需私有仓；`capture` / `restore` 需要。

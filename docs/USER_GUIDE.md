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
```

### Capture 提案状态

| 状态 | 含义 | `--yes` 是否写入 |
|------|------|------------------|
| **READY** | 来源已解析，配方可用 | 是 |
| **BLOCKED** | 如 Marketplace 未解析 / 系统资源 | 否 |
| **NEEDS-REVIEW** | 需人工或 `--analyze` | 否 |
| **SYSTEM-EXCLUDED** | 如 Codex `.system` | 否（扫描层已排除） |

`--ai` 是 `--analyze` 的别名；**默认不调用真实 LLM**。只有配置了 `localConfig.ai` provider 时才可能走模型。

## 第二台电脑：恢复

1. 安装同一程序（Claude Plugin 或 npm CLI）
2. Clone 私有仓，或：

```bash
ai-config-sync setup --repo git@github.com:you/my-ai-config.git --config-path ~/ai-config/my-ai-config
```

3. 预览并应用：

```bash
ai-config-sync plan
ai-config-sync restore --yes --allow-risk medium
```

Marketplace 类资源会走 `claude plugin marketplace add / install / enable`，**不会**手改 Claude 内部状态文件。

## Profile

- `home` / `company` 等在私有仓 `profiles/*.yaml` 中定义
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

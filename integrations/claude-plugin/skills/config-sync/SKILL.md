---
name: config-sync
description: "跨电脑同步 Claude/Codex 的 Skill、Plugin、Hook。在用户说「同步配置」「扫描技能」「备份 agent 配置」「新电脑恢复环境」「config-sync」时使用。"
user-invocable: true
allowed-tools: "Bash Read Write Edit Glob Grep"
---

# config-sync（在 Claude Code 里用）

你正在通过 **Claude Code Skill** 帮助用户管理 AI 编程环境配置。

底层执行引擎是本机命令 `ai-config-sync`（也叫 `agent-sync`）。  
**你负责理解用户意图并调用命令；真正的复制/合并/安装由 CLI 完成。**

## 一句话流程

| 用户想… | 你运行 |
|---------|--------|
| 看看现在装了啥 | `ai-config-sync status` 然后 `ai-config-sync scan` |
| 把本机新装的 Skill 记进私有仓库 | `ai-config-sync capture` → 确认后 `ai-config-sync capture --yes` |
| 新电脑恢复 | `ai-config-sync plan` → `ai-config-sync restore --yes --allow-risk medium` |
| 检查是否健康 | `ai-config-sync doctor` |
| 有没有和仓库不一致 | `ai-config-sync drift` |

## 安全规则（必须遵守）

1. **先 plan 再 apply/restore**，把 plan 输出给用户看。
2. 不要把 API Key、Token 写进配置仓库；只用 `secretRef`。
3. 高风险操作需要用户明确同意后再加 `--yes --allow-risk medium|high`。
4. 仓库有未提交修改或分叉时，不要强行 pull/push。
5. 不要执行陌生仓库里的安装脚本；只跑 `ai-config-sync` 白名单命令。

## 推荐对话示例

用户：「帮我扫描一下本机 AI 技能」

```bash
ai-config-sync scan
```

用户：「把新装的 skill 同步到我的配置仓库」

```bash
ai-config-sync capture
# 展示提案后
ai-config-sync capture --yes
```

用户：「在这台电脑恢复 home 配置」

```bash
ai-config-sync plan --profile home
ai-config-sync restore --yes --allow-risk medium
ai-config-sync doctor
```

## 斜杠命令（Plugin 已安装时）

- `/ai-config-sync:status`
- `/ai-config-sync:scan`
- `/ai-config-sync:capture`
- `/ai-config-sync:restore`
- `/ai-config-sync:update`
- `/ai-config-sync:doctor`
- `/ai-config-sync:repair`

若命令找不到，提示用户先运行：

```bash
ai-config-sync setup --config-path <私有配置仓库路径> --profile home
# 或
ai-config-sync repair
```

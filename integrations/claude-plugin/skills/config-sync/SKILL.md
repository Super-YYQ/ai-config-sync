---
name: config-sync
description: "跨电脑同步 Claude/Codex 的 Skill、Plugin、Hook。在用户说「同步配置」「扫描技能」「备份 agent 配置」「新电脑恢复环境」「初始化配置同步」「config-sync」时使用。"
user-invocable: true
allowed-tools: "Bash Read Write Edit Glob Grep"
---

# config-sync（在 Claude Code 里用）

你通过对话帮助用户管理 AI 编程环境。底层 CLI 是 `ai-config-sync`。

## 用户意图 → 你做什么

| 用户说 | 你做 |
|--------|------|
| 扫描 / 看看装了啥 | `ai-config-sync scan`（**无私有仓也可**） |
| 状态 | `ai-config-sync status` |
| 初始化 / 关联私有仓 | 问清路径或远程 URL → `ai-config-sync setup ...` |
| 备份 / 同步到仓库 | 先确认已 setup → `capture` 预览 → 确认后 `capture --yes` |
| 恢复 / 新电脑 | `plan` → 确认后 `restore --yes --allow-risk medium` → `doctor` |
| 体检 | `ai-config-sync doctor` |
| 修复入口 | `ai-config-sync repair` |

## 没有私有配置仓库时

1. **scan 仍然执行**，并用人话说明：只读本机，尚未关联仓库。  
2. **capture / restore / plan** 不要硬跑失败栈；说明需要先 setup，并主动帮用户选：
   - 本机路径 + 模板  
   - 或已有 `git@...` 远程仓  
3. 未经用户同意，不要擅自 `git push` 到远程。

## 安全

- 先 plan 再 apply/restore  
- 不把 API Key 写入配置仓  
- 高风险需用户明确同意后再 `--yes --allow-risk`  
- 脏仓库 / 分叉不要强行 pull/push  

## 斜杠命令（插件已启用时）

`/ai-config-sync:status|scan|capture|restore|update|doctor|repair`

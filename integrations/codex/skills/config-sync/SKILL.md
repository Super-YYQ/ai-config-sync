---
name: config-sync
description: "同步 Claude/Codex 的 Skill、Plugin、Hook。用户说「同步配置」「扫描技能」「备份 agent 配置」「恢复环境」「初始化配置同步」「config-sync」时使用。"
---

# config-sync（Codex）

Codex 没有 Claude 那种斜杠市场，请用本 Skill + 本机 CLI。

## 意图 → 命令

| 用户说 | 执行 |
|--------|------|
| 扫描 | `ai-config-sync scan`（无私有仓也可） |
| 状态 | `ai-config-sync status` |
| 初始化私有仓 | `ai-config-sync setup --config-path ...` 或 `--repo ...` |
| 备份 | `capture` → 确认后 `capture --yes` |
| 恢复 | `plan` → `restore --yes --allow-risk medium` → `doctor` |
| 体检 | `ai-config-sync doctor` |

## 注意

- 与 Claude **共用同一私有配置仓库**  
- Marketplace 类资源在 Claude 侧用 marketplace 配方恢复；Codex 侧用 skill/hooks 配方  
- 不要把密钥写入 git  
- 先 plan 再 apply  

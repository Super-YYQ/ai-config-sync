---
name: config-sync
description: "跨电脑同步 Claude/Codex 的 Skill、Plugin、Hook。用户说「同步配置」「扫描技能」「备份 agent 配置」「恢复环境」「config-sync」时使用。"
---

# config-sync (Codex)

用本机 CLI 管理配置（确定性执行，不要自己瞎跑安装脚本）：

```bash
ai-config-sync status
ai-config-sync scan
ai-config-sync capture
ai-config-sync capture --yes
ai-config-sync plan
ai-config-sync restore --yes --allow-risk medium
ai-config-sync doctor
```

规则：先 plan 再 apply；密钥只用 secretRef；不迁移登录态和聊天记录。

---
description: "从私有配置仓库恢复本机 Claude/Codex 环境"
---

1. 先展示计划：

```bash
ai-config-sync plan
```

2. 把 CREATE/COPY/MERGE/MANUAL 项解释给用户。
3. 用户确认后：

```bash
ai-config-sync restore --yes --allow-risk medium
ai-config-sync doctor
```

提醒：不会迁移 OAuth、聊天记录、API Key 明文。

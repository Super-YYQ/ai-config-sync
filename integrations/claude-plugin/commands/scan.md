---
description: "扫描本机 Claude/Codex 已安装的 Skill、Plugin、Hook"
---

用 Bash 运行：

```bash
ai-config-sync scan
```

向用户解释：
- managed = 已在私有配置仓库中纳管
- source-known / source-unknown = 本机有、但还没 capture
- 若有未纳管项，建议下一步 `/ai-config-sync:capture`

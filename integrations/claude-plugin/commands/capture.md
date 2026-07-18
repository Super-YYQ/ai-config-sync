---
description: "把本机新装的 Skill/Plugin 写入私有配置仓库"
---

1. 先预览提案（不要直接 --yes）：

```bash
ai-config-sync capture
```

2. 把提案用列表展示给用户（资源名、来源、目标工具、风险）。
3. 用户确认后执行：

```bash
ai-config-sync capture --yes
```

4. 若用户要求提交 git：

```bash
ai-config-sync capture --yes --commit
```

陌生目录结构可用：

```bash
ai-config-sync capture --ai
```

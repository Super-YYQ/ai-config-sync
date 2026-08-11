---
description: "查看或刷新私有配置仓库中的资产目录"
---

默认只读查看仓库中的 Skill、Plugin、Hook 等资产：

```bash
ai-config-sync inventory
```

只有用户明确要求刷新仓库页面时，才写入生成文件：

```bash
ai-config-sync inventory --write
```

写入结果为 GitHub 可直接阅读的 `ASSETS.md`，以及下载仓库后可双击打开的
`catalog/index.html`。不得把本机绝对路径、凭据或 Secret 值写进目录。

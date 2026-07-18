---
description: "查看配置同步状态：私有仓库、Profile、pending"
---

用 Bash 运行并用人话总结结果：

```bash
ai-config-sync status
```

若提示未初始化，告诉用户先执行：

```bash
ai-config-sync setup --config-path <你的私有配置仓库路径> --profile home
```

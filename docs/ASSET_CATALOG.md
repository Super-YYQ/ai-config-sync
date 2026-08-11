# 私有仓库资产目录

AI Config Sync 为私有配置仓库生成两个只读视图：

- `ASSETS.md`：GitHub/GitLab 原生渲染；
- `catalog/index.html`：自包含的卡片、搜索和筛选页面。

## 使用

查看当前仓库 Inventory，不写文件：

```bash
ai-config-sync inventory
```

对已关联仓库生成或刷新页面：

```bash
ai-config-sync inventory --write
```

对任意已有配置仓库生成：

```bash
ai-config-sync inventory --config-path /path/to/my-ai-config --write
```

机器可读输出：

```bash
ai-config-sync inventory --json
```

成功的 `capture --yes` 会在同一配置仓库事务中自动刷新两个视图；`capture --commit` 会把它们和 Resources/Recipes 放进同一个精确 pathspec commit。

## 展示内容

- 已 Capture 的 Skill、Plugin、Hook、Integration、MCP 和 Instruction；
- Claude/Codex Target 与作用域；
- Profiles；
- Source provider；
- Version policy 与 Lock revision；
- Repository copy / remote reference / needs review 可移植性；
- 指向仓库 Recipe 和 vendored Source 的相对链接。

页面不会把单次 `scan` 中尚未确认的资源标记为已备份。

## 查看 HTML

`catalog/index.html` 不依赖 CDN、数据库或后端，可以：

1. Clone 仓库后直接在本机打开；
2. 用任意本地静态服务器打开；
3. 部署到访问权限受控的私有静态站点。

GitHub 仓库文件页通常只显示 HTML 源文件。若配置 Pages/静态托管，必须先确认部署后的访问权限不会把私有资产公开。

## 文件所有权

- `ASSETS.md` 使用 `ai-config-sync:assets` 标记区；标记外文字会保留。
- `catalog/index.html` 带 generator meta marker。
- 如果目标 HTML 已存在但没有 marker，生成器拒绝覆盖。
- 输出稳定排序且不写生成时间，因此不同设备重复生成不会制造无意义 diff。

## 安全

目录生成器：

- 只读取仓库 Schema，不读取 `~/.ai-config-sync/state.json`；
- 隐藏 `local` source 的机器路径；
- 去除 HTTP URL 凭据、query 和 fragment；
- 不解析或输出 secretRef 值；
- JSON 嵌入 HTML 前转义 `<`、`>`、`&` 和 Unicode 行分隔符；
- UI 使用 DOM `textContent` 渲染资产数据；
- Capture 中的生成失败会触发整个 Capture 事务回滚。

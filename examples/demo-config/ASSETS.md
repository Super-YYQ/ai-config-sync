<!-- ai-config-sync:assets:start -->
# AI Config 备份资产目录

> [!NOTE]
> 此目录由 `ai-config-sync` 根据仓库中的 `resources.yaml`、Profiles、Recipes 与 Lock 确定性生成。请勿手工编辑标记区；它不包含密钥解析值、登录态、聊天记录或本机绝对路径。

需要搜索和筛选时，可下载并打开 [`catalog/index.html`](catalog/index.html)；若仓库配置了私有静态站点，也可直接托管该自包含页面。

## 概览

| 仓库 | 资产 | 可离线携带 | 远程引用 | 需检查 | Claude | Codex |
|---|---:|---:|---:|---:|---:|---:|
| demo-config | 2 | 1 | 0 | 1 | 2 | 2 |

## Skills (1)

| 资产 | 目标 / Recipe | Profiles | 来源 | 版本策略 | 说明 |
|---|---|---|---|---|---|
| `demo-skill` | [claude](recipes/demo-skill.yaml)<br>[codex](recipes/demo-skill.yaml) | `home` | Local source · machine path hidden | `latest-confirm` | — |

## Integrations (1)

| 资产 | 目标 / Recipe | Profiles | 来源 | 版本策略 | 说明 |
|---|---|---|---|---|---|
| `planning-with-files` | [claude](recipes/planning-with-files.yaml)<br>[codex](recipes/planning-with-files.yaml) | `company` `home` `offline-demo` | [Repository copy · sources/integrations/planning-with-files](sources/integrations/planning-with-files) | `vendored`<br>锁定：`0.0.0-offline` | Offline vendor snapshot for demos |

## Profiles

| Profile | 继承 | Include | Exclude | 最大风险 | 默认 |
|---|---|---:|---:|---|---|
| `base` | — | 0 | 0 | `medium` |  |
| `company` | `base` | 1 | 1 | `medium` |  |
| `home` | `base` | 2 | 0 | `medium` |  |
| `offline-demo` | `base` | 1 | 1 | `medium` | ✓ |

---

该页面只描述**已经进入此备份仓库**的资产；一次本机 `scan` 中尚未确认或尚未 Capture 的项目不会被误标为已备份。
<!-- ai-config-sync:assets:end -->

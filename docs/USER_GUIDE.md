# 使用说明

## 第一台电脑：初始化

1. **安装程序**
   - Claude Code：`/plugin marketplace add Super-YYQ/ai-config-sync` → `/plugin install ai-config-sync@ai-config-sync` → **新开会话**
   - 或 npm / 源码 CLI（Codex 与无插件场景）
2. **准备私有配置仓**（空模板可复制 `examples/private-config-template`）
3. **关联**

```bash
ai-config-sync setup --config-path ~/ai-config/my-ai-config --profile home
```

或在 Claude 对话说「初始化配置同步」。

4. **扫描 → 备份**

```bash
ai-config-sync scan
ai-config-sync capture --analyze          # 启发式分析未知布局
ai-config-sync capture --yes              # 只写入 READY 提案
ai-config-sync capture --yes --commit     # 可选：secret-scan 后 git commit
ai-config-sync capture --yes --commit --push  # 写入、提交、推送在同一把锁内完成
```

成功 Capture 会在同一事务中刷新私有仓库的 `ASSETS.md` 与 `catalog/index.html`。也可以独立预览或生成：

```bash
ai-config-sync inventory                  # 只读终端预览
ai-config-sync inventory --write          # 刷新 Markdown + HTML
ai-config-sync inventory --json           # 机器可读目录
```

### Capture 提案状态

| 状态 | 含义 | `--yes` 是否写入 |
|------|------|------------------|
| **READY** | 来源已解析，配方可用 | 是 |
| **BLOCKED** | 如 Marketplace 未解析 / 系统资源 | 否 |
| **NEEDS-REVIEW** | 需人工或 `--analyze`；也用于同 id 多机内容冲突 | 否 |
| **SYSTEM-EXCLUDED** | 如 Codex `.system` | 否（扫描层已排除） |

`--ai` 是 `--analyze` 的别名；**默认不调用真实 LLM**。只有配置了 `localConfig.ai` provider 时才可能走模型。

启用 Hook 后，SessionStart 会自动轻量扫描并把未纳管资源写成
`pending-review` 待确认项。这个默认流程不会自动 capture、commit 或 push；
源仓库识别不明确的资源仍保持 `NEEDS-REVIEW`，由用户确认处理方式。

## 第二台电脑：恢复

第二台电脑无需再次用 AI 分析，也不要求先安装 Skill / Plugin。只需 Node.js 与
独立 CLI；Skill / Plugin 是进入 AI 工具后的可选入口。

### 本地 Web 页面（推荐）

```bash
npx ai-config-sync ui
```

浏览器页面仅监听 `127.0.0.1`。输入一次私有仓库地址，确认目标与 Profile，
查看 Plan 后点击一次确认。Windows 全局安装后，也可双击 npm 包中的
`AI Config Sync.cmd` 启动页面。

### CLI

一条命令完成连接、Plan 与确认：

```bash
ai-config-sync bootstrap --repo git@github.com:you/my-ai-config.git --profile home
```

交互终端会显示 Plan 后询问；无人值守场景必须显式加 `--yes`。也可以沿用分步
命令：

1. Clone 私有仓，或：

```bash
ai-config-sync setup --repo git@github.com:you/my-ai-config.git --config-path ~/ai-config/my-ai-config
```

2. 预览并应用：

```bash
ai-config-sync plan
ai-config-sync restore --yes --allow-risk medium
```

Marketplace 类资源会走 `claude plugin marketplace add / install / enable`，**不会**手改 Claude 内部状态文件。

## Profile

- `home` / `company` 等在私有仓 `profiles/*.yaml` 中定义
- `extends` 支持多层继承；循环、缺失父 Profile、文件名与 `profile:` 身份不一致会直接报错
- 公司机可用更严格 profile，排除个人 skill
- `setup --profile company` 切换；资源的 `profiles` 字段控制是否纳入

## 多机备份与 Git 冲突

多台电脑可以先后备份到同一个私有仓：每台只 Capture 自己未纳管的资产，
仓库最终是所有机器的并集；恢复过的资产在本机是 managed 状态，不会重复提案。
撞车时的行为：

- `capture --commit` 写入前会自动 `git pull --ff-only`（工作区干净且配置了
  远端时），大多数"另一台机器刚 push 过"的情况会静默追上
- push 前会先 fetch 刷新远端状态；本地与远端已分叉时拒绝推送并给出修复
  指引。带 `--push` 的 capture 在已分叉时会在写入任何东西**之前**中止，
  不会制造更多分叉提交
- 手动解决：`git pull --rebase` → `resources.yaml` 按 id 取两侧并集 →
  `ASSETS.md` / `catalog/index.html` 任选一侧后用
  `ai-config-sync inventory --write` 重新生成 → 再 push
- 同一个资源 id 在两台机器上改出不同内容时，Capture 会把它标为
  **NEEDS-REVIEW**（`same-id-different-content`，比较本机目录与仓库内
  vendored 副本的内容哈希），`--yes` 不会自动写入；想两份都保留就改成
  不同的资源 id。远程引用类资源（GitHub、Marketplace）没有本地副本可比，
  仍维持静默跳过
- `capture --commit` 会做 secret-scan；不要把 `.env`、密钥、OAuth 写进私有仓
- 拉取始终是 fast-forward-only，不会自动改写分叉历史；资产级
  "保留本机 / 使用远端 / 两者保留"三选一界面仍是目标能力

## Hook Trust

- **Claude**：SessionStart 使用插件内 `bin/ai-config-sync.cjs`（优先于全局 PATH）
- **Codex**：`~/.codex/hooks.json` event-map + `features.hooks=true`；首次可能提示信任 Hook  
  Windows 会尽量写入 `commandWindows` 绝对路径。Codex Hook 为实验性支持。

## 回滚

- Apply 硬失败会自动 rollback（文件快照 + 尽量补偿本次新装 Plugin）
- 手动：`ai-config-sync rollback --last`
- Capture 写入使用临时目录 + 备份 + 替换；失败会尝试从 `.ai-config-sync-backup-*` 恢复

## Claude Code 快捷命令

```text
/ai-config-sync:scan
/ai-config-sync:capture
/ai-config-sync:restore
/ai-config-sync:status
```

插件已内置 CLI，无需先 `npm i -g`（仍可选用 npm 全局 CLI）。

## Codex

1. 确保 `ai-config-sync` 在 PATH（**npm / npx / 源码 dist**，不要依赖 Claude Plugin bin 自动进 Codex PATH）  
2. `ai-config-sync setup --config-path <私有仓> --profile home`  
3. Skill：`~/.agents/skills/config-sync`  
4. Hook：`~/.codex/hooks.json` + `features.hooks=true`  
5. 对话：「扫描技能」「备份配置」「恢复环境」

## 私有仓

- 空模板：`examples/private-config-template`（默认无演示资源）  
- 演示：`examples/demo-config`  
- GitHub 原生目录：`ASSETS.md`
- 自包含目录页：`catalog/index.html`

`scan` 无需私有仓；`capture` / `restore` 需要。

当前第二台电脑仍需安装可信的 AI Config Sync CLI。仓库内双击启动器、自动创建远端私有仓库和交互式冲突中心属于 [`PRODUCT_VISION.md`](PRODUCT_VISION.md) 中已经确认但尚未完成的目标。

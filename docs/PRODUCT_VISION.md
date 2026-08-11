# AI Config Sync 产品目标形态

> 状态：**已确认的产品方向**
> 确认日期：2026-08-11
> 约束：本文同时记录最终目标与当前实现状态；未完成能力不得在 README 中写成已经可用。

## 一句话定义

AI Config Sync 是一个以私有 Git 仓库为声明式真源的 Agent 配置备份与确定性恢复工具：电脑 A 可选择性借助 AI 消除扫描歧义，用户确认后保存资产；电脑 B 不依赖 AI，严格通过 Plan、冲突决策、Apply、Verify 和 Rollback 恢复环境。

<p align="center">
  <img src="assets/product-concept-map.svg" width="1180" alt="AI Config Sync 整体产品形态" />
</p>

## 已确认的端到端流程

<p align="center">
  <img src="assets/backup-restore-flow.svg" width="1320" alt="从电脑 A 备份到电脑 B 恢复的流程" />
</p>

### 电脑 A：发现与备份

1. 用户已经在 Claude Code / Codex 中安装了 Skills、Plugins、Hooks 等资产。
2. 用户安装 AI Config Sync 插件或 CLI，并发起“备份配置”。
3. Scanner 只读扫描本机，生成结构化 Inventory。
4. 规则引擎先处理标准布局和已知来源，形成 Capture proposals。
5. proposals 必须区分：
   - `READY`：来源与 Recipe 足够确定，可以进入批量确认；
   - `NEEDS-REVIEW`：信息不完整，必须人工确认，可选择 AI 辅助分析；
   - `BLOCKED`：违反安全或可移植性约束，不能写入；
   - `SYSTEM-EXCLUDED`：系统内置或 AI Config Sync 自身，不进入备份。
6. AI 只处理 `NEEDS-REVIEW` 的脱敏输入，并输出候选 Recipe、证据与置信度；AI 不得批准提案、写仓库或执行安装。
7. 用户对不确定项逐项或批量确认。
8. 用户关联已有私有仓库；目标形态还支持通过最小权限授权创建新的私有仓库。
9. Capture 在配置仓库锁内执行：vendor 必要文件、更新 Resources/Recipes、secret scan、Commit，并可选择 Push。
10. 同一 Capture 事务生成 `ASSETS.md` 和 `catalog/index.html`，只展示已经进入备份仓库的资产。

### 电脑 B：确定性恢复

1. 用户安装并登录 Claude Code / Codex，取得私有仓库访问权限。
2. 用户 Clone/关联私有配置仓库。
3. 当前版本需安装 AI Config Sync CLI；目标版本提供仓库内的轻量跨平台启动器，用于检查并调用可信 CLI，而不是把完整二进制提交到个人配置仓库。
4. 启动器检查：CLI 版本、目标 Agent、必要运行时、网络需求及本机 `secretRef` 是否可解析。
5. 程序拉取远端并构建不可变 Plan。
6. 对 Git 分叉、目标目录碰撞、Drift 或高风险动作，程序暂停并要求用户选择。
7. 用户确认后才 Apply；成功后 Verify，硬失败自动 Rollback。
8. 整个 B 机恢复流程不调用 AI。

## AI 边界

| 场景 | 是否允许 AI | 规则 |
|---|---|---|
| 标准资产扫描 | 否 | Scanner 和规则引擎确定性完成 |
| 不确定来源/布局分析 | 可选 | 仅接收脱敏输入；输出候选与证据 |
| Capture 最终批准 | 否 | 只有用户能确认 |
| 仓库创建、Commit、Push | 否 | 由确定性程序执行 |
| B 机 Plan / 冲突处理 | 否 | 程序列出选择，用户决定 |
| B 机 Apply / Verify / Rollback | 否 | 完全确定性 |

AI provider 不可用时，备份流程仍然可用：确定项继续处理，不确定项保留为 `NEEDS-REVIEW`，不能静默降级为已确认。

## 私有仓库契约

```text
my-ai-config/
├── config.yaml                 # 仓库级目标与安全策略
├── resources.yaml              # 资产清单
├── lock.yaml                   # 锁定版本 / commit / hash
├── profiles/                   # home / company / other device profiles
├── recipes/                    # 确定性恢复配方
├── sources/                    # 经审查后 vendored 的可移植资产
├── ASSETS.md                   # GitHub 原生只读资产目录
└── catalog/
    └── index.html              # 自包含搜索/筛选页面
```

目标阶段可增加：

```text
├── restore.cmd                 # Windows 轻量启动器
├── restore.command             # macOS 双击入口
└── restore.sh                  # Linux / shell 入口
```

启动器只负责验证并调用可信、版本匹配的 AI Config Sync CLI。仓库仍以数据为主，不提交多平台完整二进制。

## 仓库目录页规则

- `ASSETS.md` 是零部署入口，GitHub/GitLab 可以原生渲染。
- `catalog/index.html` 是无后端、无外部 CDN 的自包含页面，支持搜索及 Kind/Target/Profile 筛选。
- 目录只读取仓库中的 `resources.yaml`、Profiles、Recipes 与 Lock。
- 一次本机 `scan` 中尚未确认的项目不能显示为“已备份”。
- 不输出本机绝对路径、密钥解析值、OAuth、登录态或聊天记录。
- Markdown 使用托管标记区，保留用户在标记区外的说明。
- HTML 只允许覆盖带 AI Config Sync generator marker 的页面，防止接管用户自建页面。
- 生成结果必须稳定排序、可重复生成且不依赖机器路径或生成时间。

## 冲突模型（目标）

### Git 仓库分叉

- 无冲突更新：自动 fast-forward。
- 同一资产被两台机器同时修改：其他资产继续同步，冲突资产进入“需要处理”。
- 用户可选择：保留本机、使用远端、两个都保留。
- 每次选择前保存安全快照，决策可撤销。

### Agent 目标目录碰撞

- `CREATE`：目标不存在，可以创建。
- `UPDATE_MANAGED`：状态记录和内容证据证明由 AI Config Sync 管理，可以更新。
- `COLLISION_UNMANAGED`：已有目录不属于本工具，默认拒绝覆盖。
- `ADOPT`：用户明确把现有资产纳入管理。
- `USER_CONFIRMED_REPLACE`：用户在查看差异和备份后明确允许单次替换。

任何批量 Apply 必须先完成所有目标的 ownership preflight，不能执行一半后才发现未纳管碰撞。

## B 机恢复前置条件

“不需要 AI”不代表“没有外部前置条件”。恢复器必须清晰检查并报告：

- Claude Code / Codex 是否安装并完成登录；
- 私有仓库认证是否可用；
- `secretRef` 是否在环境变量或 Credential Manager 中解析；
- Marketplace、Git、npm 等来源所需 CLI 与网络是否可用；
- OS 权限、Hook Trust 或链接权限是否满足；
- 当前 Profile 是否适合此设备。

登录态、OAuth、聊天记录和明文密钥不属于迁移范围。

## 当前实现与目标差距

| 能力 | 当前 main | 最终目标 |
|---|---|---|
| Claude/Codex 扫描 | 已实现 | 扩展 Target Adapter |
| READY/BLOCKED/NEEDS-REVIEW | 已实现 | 批量审阅 UI 与真实可选 AI provider |
| Capture 事务、secret scan、Commit/Push | 已实现 | 远端创建与设备身份 |
| `ASSETS.md` | 已实现 | 保持 GitHub 原生入口 |
| 自包含 HTML Catalog | 已实现 | 可选私有静态托管与快照入口 |
| 自动创建私有远端 | 未实现 | Device Flow + 最小权限授权 |
| 仓库内双击恢复启动器 | 未实现 | Windows/macOS/Linux bootstrap |
| Git 资产级冲突中心 | 未实现 | 三选一处理 + 安全快照 |
| 未纳管 Skill 目标 ownership preflight | copy-based drivers 已实现 NoClobber + Apply 前复核 | 扩展 Adopt、单次替换与外部 drivers |
| B 机无 AI 恢复 | 引擎已实现 | 一键 bootstrap + 前置检查 |

## 验收标准

最终产品形态完成时，必须满足：

1. 新用户能从 Claude Code 内完成扫描、审阅、关联/创建私有仓库和备份。
2. 仓库首页可以直接查看 `ASSETS.md`；HTML 页面可以离线搜索和筛选。
3. 目录展示的每项资产都可以追溯到 Resources、Recipe 和 Source/Lock。
4. B 机在无 AI provider、无聊天上下文的情况下完成 Plan 和 Restore。
5. 所有环境写入都先显示 Plan，高风险动作和冲突都等待用户决定。
6. 硬失败能自动回滚，不留下错误的已安装状态。
7. 未纳管同名目录默认不被覆盖。
8. 不迁移或提交 OAuth、登录态、聊天记录、明文密钥和机器绝对路径。

## 决策记录

- 2026-08-11：确认 A 机可选择性使用 AI，B 机恢复必须无 AI。
- 2026-08-11：确认私有存储仓库需要轻量只读 UI，采用 `ASSETS.md` + 自包含 HTML 双入口。
- 2026-08-11：确认 README 需要整体产品形态图和 A→B 流程图。
- 2026-08-11：确认借鉴 Skills Manager 的卡片、筛选、备份历史与冲突体验，但保留 AI Config Sync 的声明式 Recipe、Plan/Apply、secretRef 和事务回滚模型。

# Skills Manager 对比与可吸收优化

> 对比基线：2026-08-11
> 参考项目：[xingkongliang/skills-manager](https://github.com/xingkongliang/skills-manager)（审查时为 1.32.0）
> 原则：借鉴产品模式和交互，不复制对方代码、品牌素材或产品身份。

## 定位差异

| 维度 | AI Config Sync | Skills Manager |
|---|---|---|
| 核心目标 | 备份并确定性重建 Agent 配置环境 | 可视化组织和部署跨 Agent Skills |
| 声明式真源 | 私有 Git 中的 Resources、Profiles、Recipes、Lock、Sources | 中央 Skills Library + 可重建 SQLite 元数据 |
| 主要资产 | Skill、Claude Plugin、Hook、Integration，后续 MCP/Instruction | Skills、Tags、Presets、Agent deployments |
| 目标工具 | 当前 Claude/Codex | 大量内置 Agent + 自定义工具 |
| 写入模型 | Plan、风险等级、显式确认、事务与回滚 | Library/Workspace 卡片、批量部署、dry-run、ownership 记录 |
| AI 角色 | 仅可选分析不确定 Capture，不参与恢复 | Marketplace/Skills 搜索辅助，不是恢复依赖 |
| UI | 仓库只读 Catalog；环境管理仍以 CLI/插件为主 | 完整 Tauri 桌面应用 + CLI |

两个项目并非简单替代关系。AI Config Sync 应吸收 Skills Manager 的可见性和组织体验，但不能退化成只管理 Skills 的桌面库。

## 本轮已经吸收

### 1. 资产库式只读仓库页面

借鉴 Skills Manager 的 Library、筛选胶囊、统计卡片、Agent badge 和侧边栏层次，实现：

- GitHub 原生 `ASSETS.md`；
- 自包含 `catalog/index.html`；
- 名称搜索；
- Kind、Target、Profile 筛选；
- 资产卡片、来源、版本策略、锁定版本和 Recipe 链接；
- Responsive 布局；
- 不引入 React、Tauri、Rust、SQLite 或后端服务。

### 2. CLI 与页面共享同一核心

`inventory` CLI、Capture 自动刷新和 HTML/Markdown 都使用同一份 `AssetCatalog` 数据结构，避免 CLI、页面和仓库状态产生三套语义。

### 3. 可重建视图

目录页不是新的数据真源。删除后可完全根据 `config.yaml`、`resources.yaml`、Profiles 和 Lock 重建，类似 Skills Manager 不把可重建 SQLite 放入备份仓库的思路。

### 4. 页面所有权保护

- Markdown 只替换 AI Config Sync 托管标记区，保留用户说明；
- HTML 只有在包含 generator marker 时才允许更新；
- Capture 生成失败时，目录页与 Resources/Recipes 一起回滚。

### 5. Copy-based Skill 目标 NoClobber

- Plan 检查目标是否不存在，或状态记录中的 path/hash 能否证明它仍由 AI Config Sync 管理；
- 无记录或内容已被替换时生成 `MANUAL collision-unmanaged`，不调用 Driver；
- Plan 保存目标存在性与 Hash，Apply 在 HOME lock 内再次验证；
- Plan 后突然出现或被修改的目录会使 Apply 失败并自动回滚。

## 下一阶段优先吸收

### P0：补全 Adopt 与所有 Driver 的 ownership

Skills Manager 1.32.0 的核心安全改进是：部署前必须证明目标是自己创建或管理的，否则拒绝替换。copy-based Skill 路径已经默认 NoClobber；下一步需要补齐显式工作流：

- `CREATE`；
- `UPDATE_MANAGED`；
- `COLLISION_UNMANAGED`；
- `ADOPT`；
- `USER_CONFIRMED_REPLACE`。

并将同一所有权规则扩展到 `npx-skills` 和其他可能触碰目标目录的外部 Driver。这必须先于更强的批量部署或一键恢复，否则 UI 会放大错误覆盖的影响。

### P1：仓库备份历史与冲突中心

吸收以下体验：

- 每次备份显示来源设备；
- Snapshot 时间线；
- Restore 前自动保存当前状态；
- 冲突资产进入“需要处理”，不阻塞其他资产；
- 保留本机 / 使用远端 / 两者保留；
- 每次决策可撤销。

AI Config Sync 的不同点：后台可以同步配置仓库，但绝不能在后台自动 Apply 到 Agent 目录。

### P1：首次使用与远端关联

- 检测已有本地仓库和远端；
- 新用户可通过 GitHub Device Flow 创建最小权限私有仓库；
- 明确展示 Token 只进入 OS Keychain；
- 提供高级 Git URL、SSH 和自托管入口。

### P1：跨平台恢复 Bootstrap

- 仓库包含薄启动器，而非完整多平台二进制；
- 启动器验证 CLI 版本和发布签名；
- 展示前置条件、Plan、冲突和恢复结果；
- 无 AI、无聊天上下文也能工作。

### P2：Inventory、Adopt、Tags 与 Profiles 体验

- 把未纳管资产显式分组；
- 支持 Adopt，但必须先展示差异和所有权变化；
- Tags 用于查找，不直接改变部署；
- 将 Skills Manager Preset 的易用性映射到 AI Config Sync Profile，而不是再造冲突概念；
- 批量修改 Profile 后只生成一个统一 Plan。

### P2：Global / Project / Linked Workspace

- 完成 Project-level Skills；
- Target Adapter registry；
- 自定义 Agent 路径；
- Linked Workspace 只管理显式授权目录；
- Agent 检测优先展示实际安装项。

### P2：来源预览和诊断导出

- 页面内查看 `SKILL.md`、README、Recipe 证据与锁定 commit；
- 比较本地备份与远端来源；
- 导出脱敏日志、Doctor、Plan 和版本信息；
- 诊断包必须再次执行 secret scan。

## 不应照搬

- 不把 SQLite 设为唯一真源；Git/YAML 继续承担声明式契约。
- 不把后台仓库同步等同于后台环境 Apply。
- 不为获得桌面 UI 而重写现有 TypeScript 安全核心。
- 不缩小为 Skill-only；Plugin、Hook、Recipe、Profile 与 secretRef 是核心差异。
- 不默认使用 symlink；如增加链接模式，必须有平台能力检测和 ownership 证明。
- 不让 AI 参与 B 机恢复、冲突决策或高风险批准。

## UI 借鉴边界

允许借鉴：

- 深色侧边栏 + 浅色工作区的信息层次；
- 统计卡片；
- 搜索栏和筛选胶囊；
- Agent/Profile badge；
- 资产卡片的可展开详情；
- Backup 页面中的历史和 Needs attention 心智模型。

保持自身识别：

- 页面标题和文案围绕“备份资产”和“确定性恢复”；
- 重点展示 Recipe、Profile、Source、Lock 和 portability；
- 始终标记只读；
- 不使用 Skills Manager 的名称、Icon、截图或代码资产。

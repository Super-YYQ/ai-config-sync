# AI Agent Config Sync

在 **Claude Code / Codex 对话里** 管理 Skill、Plugin，并同步到你的私有 Git 仓库。

> 日常用法：说话或敲斜杠命令。  
> 终端命令是给高级用户和排错用的，不是主路径。

---

## 这是什么？

你换电脑、重装环境时，往往要重新找「我装过哪些 Skill / Plugin」。

本工具做三件事：

1. **扫描**本机已经装了什么  
2. **备份**到你的私有配置仓库（只存清单和安装方式，不存密钥）  
3. **恢复**到另一台电脑  

```
Claude / Codex 对话
       │  斜杠命令 或 自然语言
       ▼
  ai-config-sync 插件 / Skill
       │
       ├─ 读本机 ~/.claude、~/.codex
       └─ 读写「私有配置仓库」（你自己的 Git 仓）
```

有两个仓库，不要混：

| 仓库 | 是什么 | 是否私有 |
|------|--------|----------|
| **程序仓库** `ai-config-sync` | 插件 + CLI 本身 | 可公开 |
| **私有配置仓库** `my-ai-config`（名字自定） | 你的清单：装了啥、怎么装 | **建议 private** |

---

## 安装插件（和别的在线插件一样）

在 Claude Code 里用官方方式装（推荐）：

```text
/plugin marketplace add Super-YYQ/ai-config-sync
/plugin install ai-config-sync@ai-config-sync
```

或终端：

```bash
claude plugin marketplace add Super-YYQ/ai-config-sync
claude plugin install ai-config-sync@ai-config-sync
claude plugin enable ai-config-sync@ai-config-sync
```

然后 **新开一个 Claude Code 会话**。

在 `/` 菜单里应能看到类似：

- `/ai-config-sync:scan`
- `/ai-config-sync:status`
- `/ai-config-sync:capture`
- `/ai-config-sync:restore`
- `/ai-config-sync:doctor`

也可以直接说：「扫描配置」「同步配置」「恢复环境」。

> 仍需本机有 Node.js，以便插件调用 `ai-config-sync` CLI。  
> 若命令找不到，见文末「排错」。

---

## 私有配置仓库什么时候配置？

**第一次要把「扫描结果备份起来」之前。**

时间线：

| 时机 | 要不要私有仓 | 说明 |
|------|--------------|------|
| 刚装好插件 | 可以没有 | 能先 `scan` 看本机 |
| 第一次 **capture（备份）** | **必须有** | 要写入 resources.yaml |
| **restore（恢复）** 到新电脑 | **必须有** | 从仓库读清单 |

关联方式（在对话里说即可）：

- 「帮我初始化配置同步」  
- 「用模板创建私有配置仓库到某个路径」  
- 「关联我的私有仓库 git@github.com:我/xxx.git」

对应底层（一般不用你手敲）：

```bash
# 本机目录（可用内置模板自动生成结构）
ai-config-sync setup --config-path ~/ai-config/my-ai-config --profile home

# 或已有远程私有仓
ai-config-sync setup --repo git@github.com:你/my-ai-config.git --profile home
```

关联结果写在本机：`~/.ai-config-sync/config.yaml`（不会进 Git）。

---

## 还没有私有配置仓库时，扫描会怎样？

**可以扫，只读，不写仓库。**

- `scan`：列出本机 Skill/Plugin，并提示「尚未关联私有配置仓库」  
- `status` / `capture` / `restore` / `plan`：会用人话提示你先初始化  
- 不会静默失败，也不会偷偷创建远程仓库  

典型输出大意：

```text
提示：尚未关联私有配置仓库。本次只是只读扫描本机，不会写入任何仓库。
若要把结果备份起来，请先 setup（对话里说「初始化配置同步」）。
```

---

## 日常怎么用（主路径：对话）

### ① 看看本机有什么

对话：

- `/ai-config-sync:scan`  
- 或：「帮我扫描本机 AI 技能」

### ② 备份到私有仓（需已 setup）

- `/ai-config-sync:capture`  
- 或：「把新装的 skill 同步到配置仓库」

先看提案，再确认写入。

### ③ 新电脑恢复

1. 装插件（同上）  
2. 关联你的私有仓：`setup --repo ...`  
3. `/ai-config-sync:restore` 或说「按私有配置恢复环境」  
4. `/ai-config-sync:doctor` 检查  

### ④ 打开 Claude 时提示有未纳管资源

说明本机多了还没备份的东西 → 跑 capture。

---

## 不会同步什么（刻意的）

- 登录态 / OAuth  
- 聊天记录、Session  
- API Key 明文（只用 `secretRef`）  
- 把整个 plugin cache 当同步源  

---

## 排错

| 现象 | 处理 |
|------|------|
| `/` 里没有 ai-config-sync 命令 | 新开会话；`claude plugin list` 看是否 enabled |
| 插件 disabled | `claude plugin enable ai-config-sync@ai-config-sync` |
| 说「扫描」但助手找不到 CLI | 安装 Node 后：`npm install -g` 或从本仓库 `npm link -w @ai-config-sync/cli` |
| capture 提示未关联仓库 | 先 setup 私有配置仓库 |
| 命令丢了 | `/ai-config-sync:repair` 或对话说「修复 config-sync」 |

---

## 给开发者

构建、包结构、Driver 扩展：见 [docs/development.md](docs/development.md)  
设计原文：`docs/AI_Agent_Config_Sync_Design_Development_v1.0.docx`  
模板：`examples/private-config-template/`  

```bash
npm install && npm run build && npm test
npm run demo:offline-pwf   # 离线恢复演示
```

版本 0.2.1 · MIT

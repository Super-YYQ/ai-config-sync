# 怎么用？（给普通人看的）

你不需要懂 monorepo。目标只有一件事：

> **在 Claude Code / Codex 对话里，用自然语言或斜杠命令，管理本机 Skill/Plugin，并同步到私有 Git 仓库。**

---

## 你需要准备什么

1. 已安装 [Node.js](https://nodejs.org/) ≥ 18  
2. 已安装 Git  
3. 已安装 Claude Code（和/或 Codex）  
4. 一台你想「备份配置」的电脑

---

## 第一次安装（只要做一次）

在终端执行：

```bash
# 1) 拿到程序
git clone https://github.com/Super-YYQ/ai-config-sync.git
cd ai-config-sync
npm install
npm run build
npm link -w @ai-config-sync/cli
# 验证：
ai-config-sync --version
```

```bash
# 2) 准备「私有配置仓库」（存你的清单，不是程序本身）
# Windows 示例：
xcopy /E /I examples\yyq-ai-config-template D:\Git\yyq-ai-config
cd /d D:\Git\yyq-ai-config
git init
git add .
git commit -m "init my ai config"
```

```bash
# 3) 关联 + 安装到 Claude / Codex
cd 路径\到\ai-config-sync
ai-config-sync setup --config-path D:\Git\yyq-ai-config --profile home
```

setup 会做这些事（幂等，可重复跑）：

| 动作 | 结果 |
|------|------|
| 写入 `~/.ai-config-sync/config.yaml` | 记住你的私有仓库路径 |
| 安装 Claude **Plugin** | 可用 `/ai-config-sync:scan` 等斜杠命令 |
| 安装 Claude **Skill** | 对话里说「同步配置」也会触发 |
| 安装 Codex Skill + Hook | Codex 里同样可用 |
| SessionStart 轻量扫描 | 打开 Claude 时提示未纳管资源 |

---

## 在 Claude Code 里怎么用（重点）

### 斜杠命令的真实名字

Claude Code 里 Plugin 命令一般是：

```
/ai-config-sync:scan
/ai-config-sync:status
/ai-config-sync:capture
...
```

如果 `/` 菜单里搜不到：

1. 确认插件已启用：
   ```bash
   claude plugin list
   # 应看到 ai-config-sync@ai-config-sync  Status: enabled
   ```
2. 若是 disabled：
   ```bash
   claude plugin install ai-config-sync@ai-config-sync
   claude plugin enable ai-config-sync@ai-config-sync
   ```
3. **完全退出并新开** Claude Code（旧会话不会加载新插件命令）。
4. 仍没有命令时，用 Skill 方式：直接说「扫描配置」或「运行 config-sync scan」。

**注意：** 当前会话若只加载了 `config-sync` Skill，也可以直接让我执行扫描，不必等斜杠菜单。


### 方式 B：直接说话

例如：

- 「帮我扫描一下本机 AI 技能」
- 「把刚装的 skill 同步到配置仓库」
- 「检查 config-sync 状态」
- 「在这台电脑恢复 home 配置」

Claude 会按 Skill 说明去跑 `ai-config-sync …` 命令。

### 方式 C：终端（高级）

```bash
ai-config-sync status
ai-config-sync scan
ai-config-sync capture --yes
ai-config-sync plan
ai-config-sync restore --yes --allow-risk medium
ai-config-sync doctor
```

---

## 日常三个场景

### ① 在这台电脑装了新 Skill，想备份

1. 用任意方式装好 Skill（Marketplace / 复制 / npx …）  
2. Claude 里：`/ai-config-sync:capture`  
3. 看提案 → 确认 → 需要的话再 commit 私有仓库并 push  

### ② 换了一台新电脑

```bash
git clone https://github.com/Super-YYQ/ai-config-sync.git
cd ai-config-sync && npm install && npm run build && npm link -w @ai-config-sync/cli

ai-config-sync setup --repo git@github.com:你/yyq-ai-config.git --profile home
# Claude 里：
# /ai-config-sync:restore
```

或直接说：「按私有配置仓库恢复环境」。

### ③ 打开 Claude 提示有未纳管资源

说明本机有新东西还没进仓库。运行：

```
/ai-config-sync:capture
```

---

## 不会同步什么（刻意的）

- 登录态 / OAuth  
- 聊天记录、Session  
- API Key 明文（只允许 `secretRef`）  
- Plugin 缓存目录整包拷贝  

---

## 命令找不到怎么办

```bash
# 确认 CLI
ai-config-sync --version
# 没有就重新 link
cd ai-config-sync && npm run build && npm link -w @ai-config-sync/cli

# 修复 Claude/Codex 入口
ai-config-sync repair
```

然后**新开一个** Claude Code 会话，再试 `/ai-config-sync:status`。

---

## 和「程序仓库 / 私有仓库」的关系

```
┌─────────────────────┐     ┌──────────────────────────┐
│ ai-config-sync      │     │ yyq-ai-config（你的私有仓）│
│ 程序：CLI + Plugin  │     │ 清单：装了啥、怎么装      │
│ 可以公开            │     │ 请保持 private           │
└─────────┬───────────┘     └────────────┬─────────────┘
          │ setup / repair               │ capture / restore
          └──────────► 本机 Claude/Codex ◄┘
                       ~/.claude  ~/.codex
                       ~/.ai-config-sync
```

---

## 离线演示（可选，看效果）

```bash
cd ai-config-sync
npm run demo:offline-pwf
```

会在临时目录里演示：无网络恢复 planning-with-files 到 Claude + Codex。

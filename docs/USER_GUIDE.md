# 使用说明

你平时**不用记一长串命令**。Claude 用斜杠，Codex 用 Skill 对话。

---

## 1. 安装

**Claude 插件（在线，和其它插件一样）：**

```text
/plugin marketplace add Super-YYQ/ai-config-sync
/plugin install ai-config-sync@ai-config-sync
```

**CLI（两工具共用）：**

```bash
npx ai-config-sync@latest --help
# 或 npm i -g ai-config-sync
```

**Codex：** 跑一次 setup 后会自动装 Skill + SessionStart Hook。

---

## 2. 私有配置仓库何时配？

| 你想做的事 | 要不要 |
|------------|--------|
| 只扫描 | 不要 |
| 备份 / 跨电脑恢复 | **要** |

对话：「初始化配置同步」即可。

---

## 3. Claude vs Codex 怎么用？

| | Claude Code | Codex |
|--|-------------|--------|
| 入口 | Plugin 斜杠命令 | Skill + Hook |
| 扫描 | `/ai-config-sync:scan` 或说话 | 说「扫描技能」 |
| 备份 | `/ai-config-sync:capture` | 说「备份配置」 |
| 恢复 | `/ai-config-sync:restore` | 说「恢复环境」 |
| 启动提示 | SessionStart Hook | SessionStart Hook |
| 配置数据 | **同一私有 Git 仓库** | **同一私有 Git 仓库** |

---

## 4. Marketplace 装的 Skill 怎么同步？

不是拷贝 plugin cache。

- 扫描识别 marketplace 目录与 git remote  
- Capture 记成 **`claude-marketplace` 配方**（仓库 + plugin 名）  
- 新电脑 Restore：官方 `claude plugin marketplace add / install / enable`  

自己的 `ai-config-sync` 插件不会进备份列表。

---

## 5. 没有私有仓时扫描？

可以，只读；提示先初始化再 capture。

---

## 6. 回滚

Apply 失败会**自动 rollback**。也可：

```bash
ai-config-sync rollback --last
```

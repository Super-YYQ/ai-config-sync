# 使用说明（给日常用户）

你平时**不用记终端命令**。在 Claude Code 里用斜杠或说话即可。

---

## 1. 装插件（一次）

和别的在线插件一样：

```text
/plugin marketplace add Super-YYQ/ai-config-sync
/plugin install ai-config-sync@ai-config-sync
```

**新开一个会话**，再输入 `/` 搜索 `ai-config-sync`。

---

## 2. 私有配置仓库什么时候配？

| 你想做的事 | 要不要私有仓 |
|------------|--------------|
| 只扫描本机有什么 | 不要 |
| 备份 / 跨电脑恢复 | **要** |

第一次备份前，在对话里说：

> 「帮我初始化配置同步」  
> 「创建私有配置仓库到 ~/ai-config/my-ai-config」

或：

> 「关联私有仓库 git@github.com:我的账号/my-ai-config.git」

---

## 3. 没有私有仓时扫描会怎样？

- **可以扫**，只读本机  
- **不会**写入 Git，也不会报崩  
- 会提示：要备份的话先初始化  

`capture` / `restore` 会明确告诉你「还没关联私有仓」，并给出下一步说法。

---

## 4. 日常三句话

| 你说 | 效果 |
|------|------|
| 扫描配置 / `/ai-config-sync:scan` | 看本机 Skill/Plugin |
| 同步配置 / `/ai-config-sync:capture` | 备份到私有仓 |
| 恢复环境 / `/ai-config-sync:restore` | 从私有仓装回来 |

体检：`/ai-config-sync:doctor`  
状态：`/ai-config-sync:status`

---

## 5. 两个仓库别混

- **ai-config-sync**：程序（插件），可公开  
- **my-ai-config**（名字自定）：你的清单，**建议 private**

密钥、登录态、聊天记录**不会**进私有仓。

---

## 6. 斜杠没有命令时

1. 新开会话  
2. `claude plugin list` 看是否 **enabled**  
3. `claude plugin enable ai-config-sync@ai-config-sync`  
4. 仍没有：直接说「扫描配置」（走 Skill，不依赖斜杠菜单）

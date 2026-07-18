# AI Agent Config Sync

> 在 **Claude Code / Codex 对话里** 管理 Skill、Plugin，并同步到私有 Git 仓库。  
> 程序负责确定性执行；AI 只负责理解你的话。

**完整人话教程 → [docs/USER_GUIDE.md](docs/USER_GUIDE.md)**

---

## 30 秒搞懂

```
你在 Claude 里说「扫描配置」
        │
        ▼
  Skill / 斜杠命令
        │
        ▼
  ai-config-sync CLI  （真正干活）
        │
        ├─► 读/写 ~/.claude、~/.codex
        └─► 更新你的私有配置仓库（清单，不是密钥）
```

---

## 安装（一次）

```bash
git clone https://github.com/Super-YYQ/ai-config-sync.git
cd ai-config-sync
npm install && npm run build
npm link -w @ai-config-sync/cli

# 私有配置仓库（用模板）
cp -r examples/yyq-ai-config-template ~/Git/yyq-ai-config   # Windows 请用资源管理器复制
cd ~/Git/yyq-ai-config && git init && git add . && git commit -m "init"

# 关联 + 装进 Claude/Codex
cd /path/to/ai-config-sync
ai-config-sync setup --config-path ~/Git/yyq-ai-config --profile home
```

setup 会：

1. 记住私有仓库路径  
2. **安装 Claude Plugin**（`/ai-config-sync:scan` 等）  
3. **安装 Claude / Codex Skill**（可自然语言调用）  
4. 注册 SessionStart 轻量扫描  

然后 **新开一个 Claude Code 会话**。

---

## 在 Claude Code 里用

### 斜杠命令

| 输入 | 作用 |
|------|------|
| `/ai-config-sync:status` | 状态 |
| `/ai-config-sync:scan` | 扫描本机技能 |
| `/ai-config-sync:capture` | 备份新技能到私有仓 |
| `/ai-config-sync:restore` | 从私有仓恢复 |
| `/ai-config-sync:doctor` | 体检 |
| `/ai-config-sync:repair` | 命令丢了就修 |

### 直接说话

- 「帮我扫描本机 AI 技能」  
- 「把新装的 skill 同步到配置仓库」  
- 「恢复 home 配置」  

---

## 终端命令（可选）

```bash
ai-config-sync status
ai-config-sync scan
ai-config-sync capture --yes
ai-config-sync plan
ai-config-sync restore --yes --allow-risk medium
ai-config-sync doctor
```

---

## 开发者

```bash
npm test
npm run demo:offline-pwf   # 离线 planning-with-files 演示
```

设计文档：`docs/AI_Agent_Config_Sync_Design_Development_v1.0.docx`  
开发说明：`docs/development.md`

版本 0.2.0 · MIT

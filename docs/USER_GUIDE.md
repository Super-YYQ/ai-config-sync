# 使用说明

## Claude Code

1. `/plugin marketplace add Super-YYQ/ai-config-sync`  
2. `/plugin install ai-config-sync@ai-config-sync`  
3. **新开会话**  
4. `/ai-config-sync:scan` 或说「扫描配置」  
5. 备份前：说「初始化配置同步」关联私有仓  

插件已内置 CLI，无需先 `npm i -g`（仍可选用 npm 全局 CLI）。

## Codex

1. 确保 `ai-config-sync` 在 PATH（插件 bin / npm / 源码 dist）  
2. `ai-config-sync setup --config-path <私有仓> --profile home`  
3. Skill：`~/.agents/skills/config-sync`  
4. Hook：`~/.codex/hooks.json`（SessionStart 事件映射）+ `features.hooks=true`  
5. 对话：「扫描技能」「备份配置」「恢复环境」  

首次可能要求 **信任 Hook**。

## 私有仓

- 空模板：`examples/private-config-template`（默认无演示资源）  
- 演示：`examples/demo-config`  

`scan` 无需私有仓；`capture` / `restore` 需要。

## 回滚

Apply 失败自动 rollback；或 `ai-config-sync rollback --last`。

---
name: config-sync
description: Manage AI agent skills/plugins via private config repo (scan, capture, restore, doctor)
---

# config-sync

Deterministic configuration sync for Claude Code and Codex.

## When to use

- After installing a new skill/plugin and you want it recorded in your private config repo
- On a new machine, to restore your managed environment
- When SessionStart reports unmanaged resources

## Commands (run via shell / Bash tool)

```bash
ai-config-sync status
ai-config-sync scan
ai-config-sync capture --yes
ai-config-sync plan
ai-config-sync apply --yes --allow-risk medium
ai-config-sync restore --yes --allow-risk medium
ai-config-sync doctor
ai-config-sync rollback --last
```

## Safety rules

- Never paste API keys into the private config repo — use `secretRef` only
- AI may propose recipes; Apply is always programmatic
- Do not force-push or overwrite divergent git state
- Prefer Plan before Apply

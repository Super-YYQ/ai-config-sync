# Architecture (summary)

## Layers

```
integrations/  Claude Plugin, Codex skill templates
      │
packages/cli   setup, status, scan, capture, plan, apply, doctor
      │
recipe-engine  plan/apply, capture, doctor, drift, vendor, AI assistant interface
      │
drivers        generic-skill, repository-layout, claude-marketplace, npx-skills
      │
scanner | git-sync | state-manager
      │
core           schemas, paths, merge, secrets, codex-hooks
```

## Data

| Artifact | Location | Git? |
|----------|----------|------|
| Local link | `~/.ai-config-sync/config.yaml` | No |
| State / backups | `~/.ai-config-sync/` | No |
| Desired config | private repo `resources.yaml`, `recipes/`, `profiles/` | Yes (private) |
| Secrets | env / OS secret store via `secretRef` | Never |

## Apply transaction

1. Snapshot existing paths + state.json  
2. Run drivers; collect external receipts  
3. On hard failure: driver.rollback(receipt) then restore snapshots / delete creates  
4. On success only: commit state draft  

## Targets

Today: `claude` | `codex` enum.  
Future: Target Adapter registry (see ROADMAP v0.4).

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

## Internal orchestration boundaries

- Setup: `setup-discovery` locates package/plugin/config roots;
  `setup-integrations` installs Claude/Codex integration assets;
  `setup-orchestrator` owns the user-visible setup workflow.
- Planning: `plan-builder` produces immutable plans and snapshots;
  `planning-helpers` resolves profiles, recipes, and sources.
- Apply: `apply-executor` owns confirmation, locks, transactions, driver calls,
  state commit, and compensating rollback; `drift-report` remains read-only.
- Capture: `capture-policy` classifies proposals; `capture-transaction` owns the
  locked stage/backup/replace transaction; `capture-types` is dependency-free.

The historic `setup.ts`, `plan-apply.ts`, and `capture.ts` paths remain thin
facades so package consumers do not need to change imports.

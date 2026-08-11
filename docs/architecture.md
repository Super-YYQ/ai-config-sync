# Architecture (summary)

## Layers

```
integrations/  Claude Plugin, Codex skill templates
      │
packages/cli   setup, status, scan, capture, plan, apply, doctor
      │
recipe-engine  plan/apply, capture, catalog, doctor, drift, vendor, AI assistant interface
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
| Generated asset views | private repo `ASSETS.md`, `catalog/index.html` | Yes (private) |
| Secrets | env / OS secret store via `secretRef` | Never |

## Apply transaction

1. Snapshot existing paths + state.json  
2. Run drivers; collect external receipts  
3. On hard failure: driver.rollback(receipt) then restore snapshots / delete creates  
4. On success only: commit state draft  

For copy-based Skill targets, Plan also records an absent/managed target
snapshot. Existing targets without a matching state path/hash become a manual
collision; Apply re-hashes the approved target under the HOME lock before the
Driver can replace it.

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
- Catalog: `catalog` builds a deterministic, machine-path-free projection of
  Resources/Profiles/Lock and renders GitHub Markdown plus self-contained HTML.
  Capture tracks both generated files in the same rollback and commit scope.

The historic `setup.ts`, `plan-apply.ts`, and `capture.ts` paths remain thin
facades so package consumers do not need to change imports.

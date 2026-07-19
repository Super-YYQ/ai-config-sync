# Development Checkpoint — Safe Personal Beta

## 1. Current stage

**Safe Personal Beta** (`v0.4.1-safe-beta.1`)

Personal day-to-day use of Claude Code / Codex skill & plugin sync is supported with:

- Transactional capture + lock release
- Restore path security (managed write roots, symlink rejection, risk recompute)
- Scoped capture commits (no `git add -A`)
- Setup defaults that do not silently modify Codex from inside the Claude plugin

**Not** a marketing “1.0” or multi-agent platform release.

## 2. Baseline

| Item | Value |
|------|--------|
| Branch | `main` |
| Checkpoint tag | `v0.4.1-safe-beta.1` |
| Baseline (pre-checkpoint work) | `a0a6df1` Safe Beta gate |
| Final checkpoint commit | *(filled at tag time; use `git rev-parse v0.4.1-safe-beta.1`)* |

## 3. Completed capabilities

- Scan local Claude / Codex skills and marketplace plugins
- Capture proposals → recipes / vendored sources / `resources.yaml`
- Capture transaction + precise rollback + repo write lock (`try/finally`)
- Restore/apply with driver plan, backup, compensating rollback
- Path security: `recipeRef` under `recipes/`, vendored under `sources/`, managed write roots only
- Apply re-validates recipe security and risk before `driver.apply`
- Symlinks rejected in source trees (including git cache)
- Setup: Claude-only default inside Claude plugin; `--target`; `--enable-codex-hook`
- `capture --commit` stages only capture-produced paths; refuses foreign staged index files
- CI: multi-OS build/test, version consistency, npm smoke, plugin structural validate

## 4. Known limits (do not claim complete)

- No full Skill Inventory / Adopt / Copy·Symlink deployment model (Stage B)
- No GUI, CC Switch integration, MCP, Instruction, extra agents
- Third-party Codex hooks: scan yes, full capture/restore no
- Project-level skill workspace incomplete
- Real Claude Code / Codex E2E is **not** covered by CI
- Secret scan still has historical allowlists / markdown exclusions
- Windows symlink tests may skip without privilege

## 5. Next stage (only)

**Stage B — Skill Inventory / Adopt / Deployment Model**

Do **not** start Stage B until this checkpoint is green on a clean machine.

## 6. Continue on a new computer

```bash
git clone https://github.com/Super-YYQ/ai-config-sync.git
cd ai-config-sync
git checkout main
git pull
git checkout v0.4.1-safe-beta.1   # optional pin
npm ci
npm run typecheck
npm run release:check
npm run validate:plugin
npm run smoke:npm
```

## 7. Files to read first next session

1. `docs/DEVELOPMENT_CHECKPOINT.md` (this file)
2. `README.md` — status + support matrix
3. `CHANGELOG.md` — Safe Beta entries
4. `packages/core/src/path-security.ts` — restore write policy
5. `packages/recipe-engine/src/plan-apply.ts` — plan/apply + revalidation
6. `packages/recipe-engine/src/capture.ts` — capture lock + transactions
7. `packages/git-sync/src/index.ts` — `commitPaths` index isolation
8. `packages/cli/src/setup.ts` — setup defaults / targets / hooks opt-in
9. `tests/unit/safe-beta-gate.test.ts` + `tests/unit/safe-beta-final-gate.test.ts`

## 8. Hygiene

This document must **not** contain machine-absolute paths, personal usernames, private config remotes, or secrets. Use only public repo URLs and generic examples.

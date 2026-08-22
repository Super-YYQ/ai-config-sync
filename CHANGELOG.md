# Changelog

## Unreleased

- Added a deterministic private-repository asset catalog with a GitHub-native
  managed `ASSETS.md` view and a self-contained responsive HTML page with
  search and Kind/Target/Profile filters.
- Added `ai-config-sync inventory` for read-only inspection and explicit
  `--write` generation against linked or existing config repositories.
- Catalog refresh now runs inside the Capture transaction, participates in
  rollback, and is included in the exact Capture commit pathspec.
- Catalog generation hides machine-local paths and remote credentials, escapes
  embedded JSON, preserves user Markdown outside its managed block, and refuses
  to replace an unrelated HTML page.
- Copy-based Skill plans now default to NoClobber: an existing target must have
  a matching AI Config Sync state path/hash, and Apply revalidates the target
  snapshot under the HOME lock before any Driver can replace it.
- Documented the confirmed A-machine capture → private repository → no-AI
  B-machine restore product shape, Skills Manager adoption decisions, product
  concept map, and end-to-end flow diagram.
- Added a new-computer Bootstrap flow shared by CLI and a local-only Web page.
  Both adapters retain the reviewed Plan and pass that exact snapshot to Apply.
- Added `ai-config-sync ui`, the `ai-config-sync-ui` executable alias, and a
  Windows `AI Config Sync.cmd` launcher that can be started by double-clicking.
- The local page binds only to `127.0.0.1`, requires an in-memory session token
  for API calls, validates Host and Origin, and shuts down after inactivity.
- Claude SessionStart now records unmanaged findings as pending-review events,
  matching the existing Codex Hook behavior without automatic commit or push.

## 0.5.0 — Public Beta

- Split Setup, Plan/Apply, and Capture into focused discovery, integration,
  orchestration, planning, execution, policy, and transaction modules while
  preserving the public API facades.
- Split unit and integration/E2E test gates; Windows runs filesystem-heavy
  suites serially with bounded cleanup retries and platform-aware timeouts.
  Isolated suites preserve both targets without invoking the operator's real
  Claude plugin installer.
- Added V8 coverage reporting with global and security-critical module
  thresholds enforced in CI and by `release:check`.
- CI now includes Node 24, runs integration/E2E separately on all three
  operating systems, and isolates package/plugin smoke checks from the matrix.
- Lock contenders no longer break fresh, partially written lock files, and an
  old releaser cannot erase a replacement owner's in-process token.
- Added tag/version/changelog validation and a trusted-publishing release
  workflow that publishes npm provenance and creates the GitHub Release.
  Windows release/version subprocesses use explicit portable launchers instead
  of deprecated shell argument concatenation.

- Plan snapshots all mutable config inputs (`resources.yaml`, `lock.yaml`, `config.yaml`, and the full profile chain), including uncommitted edits.
- Apply now requires `--yes` for every real write and revalidates the Plan while holding both config-repo and HOME locks.
- Config/source locks carry ownership tokens; an old owner cannot remove a replacement lock, and live long-running owners are not expired by age alone.
- `capture --commit [--push]` now keeps Capture → Commit → Push inside one lock; `--push` without `--commit` is rejected.
- Cached Git sources always checkout and verify the requested branch/tag/commit, including offline pinned commits.
- Directory replacement preserves the previous destination until the new tree is ready; rollback also preserves symlink destinations and uses collision-proof backup IDs.
- Profile inheritance is transitive, validates names/identity, and rejects missing parents or cycles.
- Pending events and standalone state updates are serialized to prevent lost concurrent writes.
- External Claude CLI calls inherit the explicit `--home` sandbox, so tests and alternate HOME runs cannot modify the operator's real plugin state.
- Tests no longer write capture locks into the developer's real HOME.
- Vitest upgraded to the Node 18-compatible 3.x line; `npm audit` now reports zero production and development dependency vulnerabilities.

## 0.4.2-stable-beta.1 — Stable Beta Gate (P0 fixes)

Review-driven P0 gate per `docs/ai-config-sync_最新全面审查与开发建议_a95c7ab.docx`.

### Ticket 1 — Plan Snapshot + Apply Confirmation
- Plan snapshots config-repo commit + per-action recipe hash + locked source commit
- `applyPlan` refuses a stale plan (HEAD advanced, recipe edited, source moved) before any write
- CLI `runApplyLike` now Pull → build Plan → display → confirm → Apply; plan shown before writes

### Ticket 2 — Config Repo Write Lock
- Shared `config-repo` write lock (state-manager `file-lock`) covers Capture → Commit → Push
- `capture --commit` commits under the same lock as the resources.yaml write (no cross-commit)

### Ticket 3 — Source Resolver Hardening
- `validateGitRemote` / `validateGitRef`: https|git@ only, no creds, no `-` option injection, no control chars
- Fail-closed git ops in source cache; verify final HEAD; per-cache lock; reject non-Git cache dirs

### Ticket 4 — Atomic Skill Deployment
- `atomicReplaceDirectory`: whole-target-dir replace (source-deleted files converge), symlink-safe, atomic

### Ticket 5 — Managed Config Field Policy
- `managed-fields`: merge-toml allowlist (`features.hooks`); blocks model/auth/sandbox; hooks.json via dedicated merge only

### Apply Lock
- `home-apply` lock serializes concurrent applies to one HOME (skills/hooks/state.json safe)

### release:check + E2E
- `release:check` now: typecheck, build, version, plugin validate, tests, npm smoke, pack inspection, secret scan (allowlist), git clean
- New isolated-HOME E2E: Setup → Capture → Restore → Rollback (`tests/integration/e2e-lifecycle.test.ts`)

## 0.4.1-safe-beta.1 — Safe Personal Beta checkpoint

### Security final gate
- Strict managed write roots (Claude skills only; Codex skills/hooks + exact config.toml/hooks.json)
- Block auth/history/session/cache destinations; no whole-`~/.codex` writes
- `validateTargetRecipeForApply` never swallows `operation.to` failures
- Apply re-validates recipe security + recomputed risk + source symlinks before `driver.apply`
- Git cache / all sources: nested symlink → hard block (no silent catch)
- `commitPaths` refuses foreign staged index files; rejects abs/`..` pathspecs

### Handoff
- `docs/DEVELOPMENT_CHECKPOINT.md` for cross-machine continue
- Tag `v0.4.1-safe-beta.1`

## 0.4.1+safe-beta — Safe personal Beta gate

### Capture
- Lock release always in `finally` (corrupt resources.yaml no longer leaves lock busy)
- `commitCaptureItems` returns `changedRelPaths`
- `capture --commit` uses `commitPaths` (no `git add -A`); user dirty files stay uncommitted
- Secret scan scoped to staged capture paths; porcelain v1 -z parsing

### Restore security
- Central `path-security`: recipeRef under recipes/, vendored under sources/
- Reject abs/`..` in sourcePaths/requiredPaths; managed write roots; no source symlinks
- Engine recomputes operation risk (does not trust recipe.risk alone)

### Setup defaults
- Inside Claude plugin: Claude-only by default (no Codex skill/hooks)
- `--target claude|codex|all`, `--enable-codex-hook` for SessionStart hooks
- Preview of files to create/modify before apply

## 0.4.1+review — Beta Gate (Stage A)

### P0
- Capture lock is acquired **before** reading `resources.yaml`; re-read/merge/write under lock (concurrent A+B no lost updates)

### P1
- Windows `npx`/npm shims via generic `.cmd` detection in `runCommand`
- Ship root `.claude-plugin/marketplace.json` in npm package; smoke verifies it
- Storage keys always append short hash; NFKC + reserved-name hardening
- `safeJoin` / `assertSafeRelPath` for recipe/vendor path boundaries
- Stable CLI shim atomic refresh (temp + fsync + rename)
- `version:set` refreshes lock; `release:check` = build + version check + tests

## 0.4.1+bug444 — Beta Compatibility (bug444)

### P0
- Regenerate `package-lock.json` for 0.4.1 (npm ci safe)
- Inject `__APP_VERSION__` via esbuild; CLI `--version` matches package.json
- `check-version-consistency.mjs` validates package/lock/plugin/README/CLI
- Windows-safe `runClaude`/`runCommand` via `cmd.exe /d /s /c` for `.cmd` shims

### P1
- Stable CLI shim at `~/.ai-config-sync/bin` for Codex hooks/skills
- `capture --home` passes home into capture transactions
- Capture repo-level lock (`capture-<hash>.lock`) + UUID transaction ids
- Offline marketplace add prefers packageRoot (marketplace.json), not pluginSrc
- `toStorageKey()` / `recipeRelPath()` for safe filenames (hooks:SessionStart)
- Plugin verify requires installed **and** enabled (marketplace default)

### CI
- Windows Node 20 npm smoke + plugin validate
- Version consistency + `git diff --exit-code` after build

## 0.4.1 — Beta Compatibility (bug222)

### P0
- **Plugin self-detection**: split `detectPackageRoot()` / `detectPluginRoot()`; recognize installed Claude plugin via `plugin.json` name (`ai-config-sync`), not directory basename. Setup inside the plugin skips self-install and never creates `~/.claude/skills/config-sync` fallback.
- **Precise capture rollback**: transaction records `existedBefore` per path; failure deletes newly created recipes/vendors and fully restores pre-existing dirs (no leftover files). Staging/backup live under `~/.ai-config-sync/capture-transactions/`.

### P1
- Capture temp patterns in generated `.gitignore` and private-config template
- Unified `claudeExecutable()` (`claude.cmd` on Windows) for status/install/enable/disable/uninstall
- Setup returns structured `IntegrationInstallResult`; status can be `partial` on integration failure
- Codex `commandWindows` refreshes whenever the desired absolute path changes
- `capture --yes` only auto-confirms `status === "ready"` (legacy: undefined + recipe + !needsAi); `usedAi` no longer bypasses

## 0.4.0 — Beta Compatibility (core)

### Reliability (plan 3.8)
- Apply **state draft**: commit `state.json` only after full success; include state in transaction backup
- Claude marketplace **ApplyReceipt** + compensating disable/uninstall (only what this apply added)
- Driver `verify()` for marketplace plugins

### Capture / sources
- Auto-**vendor** unknown local skills to `sources/skills/<id>` (secret-scanned)
- Group capture by **repo + skill name** (multi-skill monorepos)
- Read `~/.agents` skills-lock for npx-skills provenance

### Doctor / release
- CLI on PATH check; Codex managed SessionStart schema
- CI (OS×Node), SECURITY, CONTRIBUTING, ROADMAP, architecture.md, sync-version.mjs


## 0.3.0 — Alpha Hardening

### Breaking / important
- Production private-config template is **empty** (no demo skills). Demos live in `examples/demo-config/`.
- Default Codex skill install path is `~/.agents/skills` (still scans `~/.codex/skills` as legacy).
- Claude plugin bundles a self-contained CLI under `integrations/claude-plugin/bin/` (no `npx` in SessionStart).
- Nested `integrations/claude-plugin/.claude-plugin/marketplace.json` removed; root marketplace only.

### Features
- esbuild-bundled CLI for npm (`dist/ai-config-sync.cjs`) and Claude Plugin PATH.
- Codex hooks written in official event-map format; `features.hooks = true` on setup.
- Plugin install success avoids duplicate user-level `config-sync` skill.

### Docs
- README clarifies Alpha status, Claude Plugin self-contained goal, Codex path, limitations.

## 0.2.2
- Transactional auto-rollback, marketplace capture, dual-target recipes, profile isolation.

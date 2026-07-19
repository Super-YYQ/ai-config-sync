# Changelog

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

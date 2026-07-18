# Changelog

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

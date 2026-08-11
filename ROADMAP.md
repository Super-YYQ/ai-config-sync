# Roadmap

## v0.3 Alpha Hardening — **shipped (core blockers)**

- [x] Bundle CLI into Claude Plugin `bin/`
- [x] npm single-file package + smoke test
- [x] Codex event-map hooks + `features.hooks`
- [x] `~/.agents/skills` default + legacy scan
- [x] Empty private template / demo-config split
- [x] Nested marketplace manifest removed
- [x] State draft commit + marketplace compensating rollback
- [x] Vendor unknown local skills on capture

## v0.4 Beta Compatibility

- [x] Multi-skill identity (repo + name, not repo alone)
- [x] skills-lock / agents lock source detection
- [x] Doctor: CLI presence + Codex hook schema
- [ ] Full Target Adapter package (`packages/targets`)
- [ ] Full Source Provider package
- [ ] Project-level skills end-to-end
- [ ] Instruction managed blocks apply path
- [ ] Drift for plugins/hooks beyond skills

## v0.5 Public Beta

- [x] CHANGELOG / SECURITY / CONTRIBUTING / ROADMAP
- [x] CI matrix (OS × Node)
- [x] Version sync script
- [ ] docs/architecture.md full set
- [x] Release workflow + npm trusted publishing with provenance
- [ ] Broader multi-OS manual smoke checklist automation

## v0.6 Repository Experience

- [x] Deterministic repository `AssetCatalog` model
- [x] GitHub-native generated `ASSETS.md`
- [x] Self-contained responsive `catalog/index.html` with search and filters
- [x] `inventory` CLI for existing repositories
- [x] Refresh catalog inside the Capture transaction and precise commit scope
- [x] Preserve user Markdown and refuse non-owned HTML replacement
- [x] NoClobber ownership preflight + target snapshot revalidation for copy-based Skill drivers
- [ ] Explicit `ADOPT` / one-shot confirmed replacement and external-driver ownership coverage
- [ ] Snapshot/device metadata for repository history

## v0.7 Guided Backup

- [ ] Batch review UX for READY / BLOCKED / NEEDS-REVIEW proposals
- [ ] Optional real AI provider for sanitized NEEDS-REVIEW analysis only
- [ ] GitHub Device Flow with OS keychain storage
- [ ] Create a least-privilege private remote or link any existing Git remote
- [ ] Asset-aware divergence/conflict model with keep-local / use-remote / keep-both
- [ ] Restore-before-decision safety snapshots

## v0.8 Deterministic Restore Bootstrap

- [ ] Thin Windows/macOS/Linux launchers in the private repository template
- [ ] Trusted CLI version/signature verification and prerequisite checks
- [ ] Guided pull → Plan → conflict decision → confirm → Apply → Verify
- [ ] No-AI restore acceptance suite on clean machines
- [ ] Real logged-in Claude Code / Codex smoke coverage

## Later / Extended

- MCP servers with secretRef
- More AI coding tools via Target Adapters
- Bitwarden/KeePass secret providers
- Activity timeline and redacted diagnostics export

The confirmed end-state and its non-negotiable AI/security boundaries are recorded in
[`docs/PRODUCT_VISION.md`](docs/PRODUCT_VISION.md). Skills Manager comparison and
adoption decisions are recorded in
[`docs/SKILLS_MANAGER_LEARNINGS.md`](docs/SKILLS_MANAGER_LEARNINGS.md).

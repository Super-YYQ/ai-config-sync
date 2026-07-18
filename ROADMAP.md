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
- [ ] Release workflow + npm publish automation
- [ ] Broader multi-OS manual smoke checklist automation

## v0.6 Extended

- MCP servers with secretRef
- More AI coding tools via Target Adapters
- Bitwarden/KeePass secret providers

# Contributing

Thanks for helping improve AI Config Sync.

## Development

```bash
npm install
npm run build
npm test
npm run smoke:npm
```

Requirements: Node.js ≥ 18, Git.

## Project layout

- `packages/*` — library packages
- `drivers/` — install drivers
- `integrations/claude-plugin` — Claude Marketplace plugin (includes bundled CLI in `bin/`)
- `integrations/codex` — Codex skill templates
- `examples/private-config-template` — empty user template
- `examples/demo-config` — offline demos/tests only

## Pull requests

1. Keep changes focused; prefer tests for bug fixes.
2. Run `npm test` and `npm run build` before pushing.
3. Do not commit secrets, personal paths, or real private-repo URLs.
4. Update `CHANGELOG.md` for user-visible changes.
5. Keep versions in sync with `node scripts/sync-version.mjs <ver>` when cutting a release.

## Code style

- TypeScript strict
- Match existing naming and file structure
- No drive-by refactors in feature PRs

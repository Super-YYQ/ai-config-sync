# Private config template

Copy this directory to start a personal private config repo (e.g. `my-ai-config`).

```bash
cp -r examples/private-config-template ~/Git/my-ai-config
cd ~/Git/my-ai-config
git init && git add . && git commit -m "init private ai config"
```

Then:

```bash
npx ai-config-sync setup --config-path ~/Git/my-ai-config --profile home
npx ai-config-sync plan
npx ai-config-sync apply --yes --allow-risk medium
npx ai-config-sync doctor
```

## Offline demo: planning-with-files (vendored)

The template vendors a **minimal dual-tool snapshot** of planning-with-files:

```
sources/integrations/planning-with-files/
  .claude-plugin/marketplace.json   # proves Marketplace layout exists
  skills/planning-with-files/       # Claude offline copy source
  .codex/skills/...                 # Codex skill
  .codex/hooks.json + hooks/        # Codex hooks (merge + scripts)
```

Profile `offline-demo` only includes this resource (no demo-skill).

```bash
# from ai-config-sync repo root
npm run build
npx tsx scripts/demo-offline-pwf.ts
# or manually:
npx ai-config-sync setup --config-path <template-copy> --profile offline-demo
npx ai-config-sync apply --yes --allow-risk medium --offline
npx ai-config-sync drift
```

Expected after apply (no network):

- `~/.claude/skills/planning-with-files/SKILL.md`
- `~/.codex/skills/planning-with-files/SKILL.md`
- `~/.codex/hooks.json` contains `planning-with-files-session-start`
- `~/.codex/config.toml` has `features.hooks = true`
- Second apply → `SKIP` for both tools

## Layout

| Path | Purpose |
|------|---------|
| `config.yaml` | Repo-level defaults |
| `resources.yaml` | Desired resource inventory |
| `lock.yaml` | Locked commits/versions |
| `profiles/` | base / home / company / offline-demo |
| `recipes/` | Confirmed install recipes |
| `sources/` | Vendored or custom skill/hook sources |
| `instructions/` | Managed CLAUDE.md / AGENTS.md fragments |

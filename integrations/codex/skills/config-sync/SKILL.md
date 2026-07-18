---
name: config-sync
description: Sync AI agent skills/plugins via ai-config-sync CLI and private config repo
---

# config-sync (Codex)

Use the `ai-config-sync` CLI. Confirmed recipes restore without AI.

## Typical flow

1. `ai-config-sync setup --config-path <private-repo> --profile home`
2. `ai-config-sync scan`
3. `ai-config-sync capture --yes`
4. On another machine: `ai-config-sync setup --repo <url> && ai-config-sync restore --yes --allow-risk medium`
5. `ai-config-sync doctor`

## Safety

- No secret plaintext in git
- No automatic pull/push on dirty or diverged repos
- Field-level merge for hooks.json and config.toml

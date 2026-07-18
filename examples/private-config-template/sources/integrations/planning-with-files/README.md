# planning-with-files (offline vendor snapshot)

This is a **minimal offline fixture** that mimics the dual-tool layout of
[OthmanAdi/planning-with-files](https://github.com/OthmanAdi/planning-with-files):

| Path | Role |
|------|------|
| `.claude-plugin/` | Marketplace + plugin manifests (online Claude install) |
| `skills/planning-with-files/` | Claude skill payload (offline copy target) |
| `.codex/skills/planning-with-files/` | Codex skill payload |
| `.codex/hooks.json` | Managed hook entries (field-merge) |
| `.codex/hooks/` | Hook scripts copied under user hooks dir |

**Not** a full upstream mirror — enough structure for `ai-config-sync` to
restore Claude + Codex **without network**.

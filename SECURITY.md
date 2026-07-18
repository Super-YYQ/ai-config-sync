# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.4.x   | Yes (current — Alpha / Beta compatibility) |
| 0.3.x   | Best effort |
| < 0.3   | Best effort |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Email the maintainer via GitHub profile contact on
[Super-YYQ/ai-config-sync](https://github.com/Super-YYQ/ai-config-sync)
or open a private security advisory on the repository.

Include:

- Description and impact
- Reproduction steps
- Affected version / commit

## Design boundaries

This project intentionally **does not** sync:

- OAuth / login cookies
- Chat sessions
- Plaintext API keys (use `secretRef` + local env only)

Capture runs secret scanning before commit/vendor. If a false positive blocks you, exclude the file and report the pattern.

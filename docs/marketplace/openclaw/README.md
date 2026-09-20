# LyraShield AI OpenClaw skill

The marketplace repository remains Apache-2.0. Only the files in this `openclaw/` directory are
also available under MIT-0 so they can be published at
[ClawHub](https://clawhub.ai/ecryptoguru/skills/lyrashield), which requires that license for skill
releases. This is a community listing, not an official OpenClaw marketplace acceptance.

## ClawHub v0.1.28 release notes

- Corrected the canonical skill identifier to `lyrashield`.
- Added security metadata; an API key is an optional read-only or CI fallback.
- Hosted OAuth writes require a browser-confirmed connection grant, write scope and execution-time checks.

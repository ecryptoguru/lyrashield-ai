# LyraShield AI Gemini CLI extension

This tagged extension uses the published `@lyrashield/mcp` stdio package and the shared
credential store. Add the `gemini-cli-extension` topic to the public repository before
publishing a release tag, as required by the Gemini CLI gallery.

Run `lyrashield login --oauth` first, and leave the extension API-key setting empty to use
that local credential store. The launcher removes inherited URL and credential overrides,
preserving the stored OAuth issuer. An optional explicit extension API key uses
`https://app.lyrashieldai.com` only.

Published MCP 0.2.2 does not refresh expired OAuth tokens; log in again when the session expires.

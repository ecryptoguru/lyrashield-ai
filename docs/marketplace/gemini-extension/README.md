# LyraShield AI Gemini CLI extension

This tagged extension uses the published `@lyrashield/mcp` stdio package and the shared
credential store. Add the `gemini-cli-extension` topic to the public repository before
publishing a release tag, as required by the Gemini CLI gallery.

Run `lyrashield login --oauth` first, and leave the extension API-key setting empty to use
that local credential store. The launcher removes inherited credential overrides while preserving
`LYRASHIELD_API_URL`; an optional explicit extension API key uses
`https://app.lyrashieldai.com` only.

Published MCP 0.2.4 refreshes expired stored OAuth credentials before the stdio server starts,
including with an explicit API URL override.

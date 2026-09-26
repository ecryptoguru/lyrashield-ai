# LyraShield AI Gemini CLI extension

This tagged extension uses the published `@lyrashield/mcp` stdio package and the shared
credential store. Add the `gemini-cli-extension` topic to the public repository before
publishing a release tag, as required by the Gemini CLI gallery.

Use Node.js 24 and run `npx -y lyrashield@0.2.12 login --oauth` first. Leave the extension API-key setting empty to use
that local credential store. The launcher removes inherited credential overrides while preserving
`LYRASHIELD_API_URL`; an optional explicit extension API key uses
`https://app.lyrashieldai.com` only.

MCP 0.2.9 refreshes expired stored OAuth credentials against the stored issuer before the
stdio server starts. An explicit API URL override applies to subsequent LyraShield API calls.

After connecting, call `lyrashield_list_workspaces`, then list an authorized target. If the
credential expires or is revoked, repeat CLI login and restart Gemini. Remove the extension
through Gemini's extension manager; revoke the credential in LyraShield settings when it must no
longer authorize any local client.

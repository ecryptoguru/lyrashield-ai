# LyraShield AI MCP Server — Setup

Run bounded security scans, review findings with their evidence states, and drive the fix → verify loop from Zed's agent panel.

## 1. Connect with OAuth (recommended)

Run the following once in a terminal, select one workspace in the browser, then restart Zed:

```sh
lyrashield login --oauth
```

The extension starts `@lyrashield/mcp`, which reads the user-only credential from
`~/.lyrashield/credentials.json`. No credential belongs in a project file or Zed settings.

## 2. API-key fallback

Open [LyraShield AI](https://app.lyrashieldai.com) and go to **Settings → API keys**.

Create a key with the scopes you need:

- **Read-only** for listing workspaces, targets, scans, findings, and launch readiness.
- **Read & write** to start scans, record fix proposals, queue retests, and generate reports.

Your key starts with `lsk_…`.

## 3. Add fallback settings only when needed

Open your Zed settings and add:

```json
{
  "context_servers": {
    "lyrashield-mcp": {
      "settings": {
        "api_key": "lsk_your_key_here"
      }
    }
  }
}
```

Stored OAuth preserves an explicit `LYRASHIELD_API_URL` override. Inherited credential overrides
are removed before MCP starts. An explicit API key uses `https://app.lyrashieldai.com` only.

Published MCP 0.2.4 refreshes expired stored OAuth credentials before the stdio server starts,
including with an explicit API URL override.

## Requirements

- **Node.js** v24 or newer (Zed provides its own Node binary; you do not need to install one manually).
- The `@lyrashield/mcp` package is pinned to version 0.2.4; releases deliberately update this pin.

## Available tools

All tools call the LyraShield REST API with the OAuth credential or fallback key. Mutating tools ask
for approval before running.

See the full tool list and behavior in the [`@lyrashield/mcp` README](https://www.npmjs.com/package/@lyrashield/mcp).

## Troubleshooting

**Authentication errors from the tools** — run `lyrashield login --oauth` again, restart Zed, and
confirm the selected workspace. If using the fallback, check that `api_key` has the required scope.

**Server fails to start** — confirm Zed can reach `https://registry.npmjs.org` to download the package.

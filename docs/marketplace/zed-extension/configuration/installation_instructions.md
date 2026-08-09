# LyraShield AI MCP Server — Setup

Run verified security scans, review findings, and drive the fix → verify loop from Zed's agent panel.

## 1. Get a LyraShield API key

Open [LyraShield AI](https://app.lyrashieldai.com) and go to **Settings → API keys**.

Create a key with the scopes you need:

- **Read-only** for listing workspaces, targets, scans, findings, and launch readiness.
- **Read & write** to start scans, record fix proposals, queue retests, and generate reports.

Your key starts with `lsk_…`.

## 2. Add the server to your Zed settings

Open your Zed settings and add:

```json
{
  "context_servers": {
    "lyrashield-mcp": {
      "settings": {
        "api_key": "lsk_your_key_here",
        "api_url": "https://app.lyrashieldai.com"
      }
    }
  }
}
```

`api_url` is optional and defaults to `https://app.lyrashieldai.com`.

## Requirements

- **Node.js** v20 or newer (Zed provides its own Node binary; you do not need to install one manually).
- The `@lyrashield/mcp` package is downloaded and kept up to date automatically.

## Available tools

All tools call the LyraShield REST API with your key. Mutating tools ask for in-editor approval before running.

See the full tool list and behavior in the [`@lyrashield/mcp` README](https://www.npmjs.com/package/@lyrashield/mcp).

## Troubleshooting

**"Missing settings" or the setup panel keeps appearing** — `api_key` is absent or empty. Add it under `context_servers.lyrashield-mcp.settings.api_key`.

**Authentication errors from the tools** — check that your key has the required scope and that `api_url` is correct.

**Server fails to start** — confirm Zed can reach `https://registry.npmjs.org` to download the package.

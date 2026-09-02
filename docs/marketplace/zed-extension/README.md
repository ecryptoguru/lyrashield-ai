# LyraShield AI MCP

Zed extension for the [LyraShield AI](https://lyrashieldai.com) MCP server. Adds bounded security scans, evidence-state review, and the fix → verify loop to the Zed agent panel.

## Setup

Requires Node.js 24 or newer.

The `@lyrashield/mcp` package is pinned to version 0.2.2; releases deliberately update this pin.

Run `lyrashield login --oauth` once in a terminal, select one workspace, then restart Zed. The
extension starts the local MCP server with that user-only credential store; no secret goes into Zed
settings.

For CI or an environment that cannot complete OAuth, add an API key under
`context_servers.lyrashield-mcp.settings.api_key`:

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

The API URL comes from the credential store or the MCP package default. No environment URL override is injected.

See `configuration/installation_instructions.md` for full setup and troubleshooting.

## License

Extension source is Apache-2.0. The hosted LyraShield service and the `@lyrashield/mcp` package are not included.

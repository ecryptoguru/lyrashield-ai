# LyraShield AI MCP

Zed extension for the [LyraShield AI](https://lyrashieldai.com) MCP server. Adds verified security scans, findings review, and the fix → verify loop to the Zed agent panel.

## Setup

The `@lyrashield/mcp` package is downloaded and kept up to date automatically.

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
        "api_key": "lsk_your_key_here",
        "api_url": "https://app.lyrashieldai.com"
      }
    }
  }
}
```

`api_url` is optional and defaults to `https://app.lyrashieldai.com`.

See `configuration/installation_instructions.md` for full setup and troubleshooting.

## License

Extension source is Apache-2.0. The hosted LyraShield service and the `@lyrashield/mcp` package are not included.

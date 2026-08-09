# Cline MCP Install — LyraShield AI

1. Open Cline and click **MCP Servers** → **Configure MCP Servers**.
2. Add the LyraShield server to your `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "lyrashield": {
      "type": "streamableHttp",
      "url": "https://app.lyrashieldai.com/api/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_LYRASHIELD_API_KEY>"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

3. Replace `<YOUR_LYRASHIELD_API_KEY>` with your API key from https://app.lyrashieldai.com/dashboard/settings.
4. Save the file. Cline will discover the tools automatically.

For the full Cline MCP Marketplace listing, open an issue at https://github.com/cline/mcp-marketplace/issues/new?template=mcp-server-submission.yml with:

- **GitHub Repo URL:** https://github.com/ecryptoguru/lyrashield-marketplace
- **Logo Image:** https://raw.githubusercontent.com/ecryptoguru/lyrashield-marketplace/main/assets/lyrashield-400.png
- **Reason for Addition:** LyraShield gives Cline users evidence-backed release-assurance tools (security scans, fix proposals, retests, and launch-readiness) over a standard MCP connection.

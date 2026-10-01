# LyraShield AI for GitHub Copilot Cloud Agent

**State: PREPARATION.** This guide describes GitHub's documented repository MCP settings and Agents
secrets. It is documentation-only: LyraShield has no authenticated Copilot Cloud Agent or Copilot
Code Review runtime receipt, and no public plugin listing is claimed.

GitHub Copilot Cloud Agent and Copilot Code Review share repository-level MCP settings. GitHub
currently does not support remote MCP OAuth for either surface. The portable LyraShield plugin can
provide skills, but its hosted OAuth MCP descriptor does not authenticate Cloud Agent. For this
read-only surface, install only the `get-started`, `review-changes`, and `launch-readiness` skills.
Copy those skill directories from the marketplace package's `skills/` into the repository's
`.github/skills/` directory. Do not install `scan-project`, `fix-and-retest`, or the backward-
compatible `lyrashield` skill here: their recorded scans, fixes, and retests need an OAuth-capable
client. The `review-changes` skill is limited to its read-only diff advisory on this surface; its
optional recorded scan action is not allowlisted. Installing a plugin or discovering a skill does
not prove that MCP authentication works.

## Configure read-only MCP access

Create a **read-only** workspace API key in LyraShield AI and restrict it to the intended workspace.
In GitHub, open the repository's **Settings → Code, planning, and automation → Copilot → MCP
servers** and add this JSON configuration:

```json
{
  "mcpServers": {
    "lyrashield": {
      "type": "http",
      "url": "https://app.lyrashieldai.com/api/mcp",
      "headers": {
        "Authorization": "Bearer $COPILOT_MCP_LYRASHIELD_API_KEY"
      },
      "tools": [
        "lyrashield_check_diff",
        "lyrashield_get_launch_readiness",
        "lyrashield_list_targets",
        "lyrashield_list_workspaces"
      ]
    }
  }
}
```

Then add the API key as a repository **Agents** secret, not an Actions secret:

1. Open **Settings → Security → Secrets and variables → Agents → Secrets**.
2. Create a repository secret named `COPILOT_MCP_LYRASHIELD_API_KEY` and paste the read-only key as its value.
3. Save the MCP configuration and verify GitHub accepts it.

Only `COPILOT_MCP_`-prefixed Agents secrets and variables are available to the repository MCP
configuration. Never put the key in `.github/copilot/settings.json`, another committed file, a
prompt, or a skill. GitHub tools run autonomously without an extra approval prompt, so retain the
read-only tool allowlist and omit `*`. The same MCP configuration is also available to Copilot Code
Review; GitHub Code Review exposes only tools marked `readOnlyHint: true` by their MCP server.

This API key can authenticate read calls only. Hosted scans, fix proposals, retests and other
mutations still require a browser-confirmed LyraShield OAuth delegation and return
`connect_required` without it. Use an OAuth-capable client such as Copilot CLI or an IDE client for
those workflows; this Cloud Agent guide does not claim full-workflow support.

## Official references

- [GitHub Copilot plugins](https://docs.github.com/en/copilot/concepts/agents/about-plugins)
- [Agent skills for Copilot Cloud Agent](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills)
- [MCP and GitHub Copilot Cloud Agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/mcp-and-cloud-agent)
- [Configure repository MCP servers](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers)
- [Configure Copilot Agents secrets](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/configure-secrets-and-variables)

Contracts checked 2026-10-01. Listing state and runtime acceptance are separate from documentation
support.

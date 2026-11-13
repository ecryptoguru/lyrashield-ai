# LyraShield AI for Devin Desktop Cascade

**State: PREPARATION.** This is a Cascade-only config snippet and shared-skill bundle. No authenticated Desktop runtime receipt or public listing is confirmed. This is not Devin cloud configuration or the Local Agent/CLI plugin flow.

Use Cascade's `...` menu → **Open MCP config file**, then merge [`mcp_config.json`](./mcp_config.json) into the existing `mcpServers` object. The documented path is `~/.config/devin/mcp_config.json` on macOS/Linux (or `$XDG_CONFIG_HOME/devin/mcp_config.json`) and `%APPDATA%\devin\mcp_config.json` on Windows. Devin Desktop documents remote HTTP OAuth; do not put tokens in the file. Enterprise users may need an administrator to enable MCP and allowlist server ID `lyrashield`. Cascade has no MCP marketplace or one-click install.

Copy selected shared skills to workspace `.devin/skills/<name>/` (or `.agents/skills/`, also documented for Desktop), then verify discovery. Keep the surfaces separate: Cascade uses this file, Local Agent/CLI uses [`devin-cli`](../devin-cli/README.md), and cloud sessions use web-app connections.

Sources: [Cascade MCP and OAuth](https://docs.devin.ai/desktop/cascade/mcp), [Cascade skills](https://docs.devin.ai/desktop/cascade/skills), [Devin CLI plugin surface](https://docs.devin.ai/cli/extensibility/plugins/overview).

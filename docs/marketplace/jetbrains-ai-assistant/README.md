# LyraShield AI for JetBrains AI Assistant

**State: PREPARATION.** MCP JSON and optional shared skills are staged. `@lyrashield/mcp@0.2.12` and CLI `lyrashield@0.2.14` are published. No authenticated runtime receipt or public plugin listing is confirmed.

In Settings → Tools → AI Assistant → Model Context Protocol (MCP), add the `mcpServers.lyrashield` block from [`mcp.json`](./mcp.json) and choose project or global scope. Preserve existing MCP definitions. Run `npx -y lyrashield@0.2.14 login --oauth` as the same OS user. Local stdio reads the CLI credential store and embeds no secret. Node.js 24 or newer is required by the MCP package.

AI Assistant documents Agent Skills for **Claude Agent and Codex**. Import selected shared skills through the IDE's Skills page only for those supported agents. Do not claim Junie or every AI Assistant agent consumes these skills; see [`jetbrains-junie`](../jetbrains-junie/README.md) for Junie.

Verify the server is connected, inspect its tools and make a read-only call. Setup is not runtime acceptance.

Sources: [AI Assistant MCP](https://www.jetbrains.com/help/ai-assistant/mcp.html), [AI Assistant Agent Skills](https://www.jetbrains.com/help/ai-assistant/agent-skills.html), [AI Assistant agents](https://www.jetbrains.com/help/ai-assistant/agents.html).

# LyraShield AI for Junie

**State: PREPARATION.** Shared skills and a local MCP snippet are staged. `@lyrashield/mcp@0.2.12` and CLI `lyrashield@0.2.14` are unpublished candidates; wait for the coordinated release. Junie CLI, Junie IDE, and JetBrains AI Assistant remain distinct surfaces; no runtime receipt is confirmed here.

Merge [`mcp.json`](./mcp.json) into project `.junie/mcp/mcp.json` or user `~/.junie/mcp/mcp.json` (Windows: `%USERPROFILE%\.junie\mcp\mcp.json`). Preserve other entries. After release, run `npx -y lyrashield@0.2.14 login --oauth` in the same OS account. Local stdio reads the LyraShield credential store; Node.js 24 or newer is required.

Junie CLI's MCP Installation Assistant supports remote OAuth. Junie IDE's current plugin docs say security tokens in MCP configs are unsupported, so this bundle uses local stdio and embeds no credential. Configure and verify hosted OAuth separately if using Junie CLI.

Copy selected skills to `.junie/skills/<name>/` or `~/.junie/skills/<name>/`; Junie CLI and IDE support Agent Skills, and the CLI also reads `.agents/skills/`. Test discovery in the exact surface/version.

Sources: [Junie Agent Skills](https://junie.jetbrains.com/docs/agent-skills.html), [Junie CLI MCP/OAuth](https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html), [Junie IDE plugin](https://junie.jetbrains.com/docs/junie-ide-plugin.html).

# LyraShield AI for Roo Code

**State: PREPARATION.** The local stdio snippet and shared skills are staged. `@lyrashield/mcp@0.2.12` and CLI `lyrashield@0.2.14` are published. Roo runtime acceptance and a public listing are unverified.

Merge [`mcp.json`](./mcp.json) into project `.roo/mcp.json` or add it using Roo's global MCP settings. Preserve unrelated entries; project config takes precedence over a same-named global server. The config intentionally omits `alwaysAllow` so Roo retains its normal approval behavior.

Run `npx -y lyrashield@0.2.14 login --oauth` in the same OS account. The local stdio server uses the CLI credential store. Node.js 24 or newer is required by the MCP package.

Copy selected shared skill folders into project `.agents/skills/` or `.roo/skills/`. Roo supports both; `.roo/` wins on same-level name collisions. Verify component discovery and a read-only call before requesting an explicitly authorized scan.

Sources: [Roo MCP configuration](https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo/), [skills](https://roocodeinc.github.io/Roo-Code/features/skills/), [marketplace](https://roocodeinc.github.io/Roo-Code/features/marketplace/).

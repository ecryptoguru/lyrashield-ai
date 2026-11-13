# LyraShield AI for Oh-My-Pi

**State: PREPARATION.** Native config and shared skills are staged. The local alternative pins published `@lyrashield/mcp@0.2.12` and CLI `lyrashield@0.2.14`. No authenticated runtime receipt or public listing is confirmed.

Oh-My-Pi has its own loader and config paths; do not use Pi-core `.pi/mcp.json` or `~/.pi/agent/mcp.json` here.

For hosted OAuth, merge [`mcp.json`](./mcp.json) into project `.omp/mcp.json` or the default-profile user file `~/.omp/agent/mcp.json`. OMP binds OAuth credentials to the MCP URL and active profile; use `/mcp reauth lyrashield` when authorization is needed. For local stdio, use [`mcp-stdio.json`](./mcp-stdio.json) instead and authenticate the LyraShield CLI. Copy only one definition named `lyrashield`; duplicates are not merged.

Copy selected skills into project `.omp/skills/<name>/` or user `~/.omp/agent/skills/<name>/`. Confirm `/mcp` shows the server and make a read-only call. Scans still require an explicit request.

Sources: [OMP configuration and paths](https://github.com/can1357/oh-my-pi/blob/main/docs/config-usage.md), [OMP MCP formats and OAuth](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-server-tool-authoring.md), [OMP repository](https://github.com/can1357/oh-my-pi).

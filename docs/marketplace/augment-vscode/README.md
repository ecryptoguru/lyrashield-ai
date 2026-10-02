# LyraShield AI for Augment in VS Code

**Native workflow bundle: PREPARATION ONLY.** Augment has native skills, custom commands, rules and
MCP support in its VS Code extension. Direct MCP tools can be connected with the published CLI
`0.2.14` and MCP `0.2.12`. The workflow bundle is prepared but does not yet have a matching
immutable marketplace release. Do not copy skills from the mutable source branch. No authenticated
Augment runtime receipt or marketplace listing is confirmed for this IDE surface. This guide is for
Augment's VS Code extension, not the Auggie CLI plugin at [`../augment/`](../augment/README.md).

## Install skills and commands

Skills and custom commands are Public Beta opt-ins. Use VS Code extension **0.789.0 or later** and
enable the relevant features in Augment Settings. After the coordinated release, copy only selected
skill directories from the released marketplace export's `augment/plugins/lyrashield/skills/` to the project
`.augment/skills/` directory. For user scope, use `~/.augment/skills/`. Inspect any same-named
destination first and preserve custom content.

If you want explicit slash commands, copy the selected Markdown files from
`augment/plugins/lyrashield/commands/` into `.augment/commands/` (or `~/.augment/commands/`). The
command files are independent of the skill installation.

Augment's rule renderer uses the project file `.augment/rules/lyrashield.md` for LyraShield-owned
guidance. Keep that file separate from `.augment-guidelines`, `AGENTS.md`, `CLAUDE.md`, and other
user-authored rules. Rules and user guidelines have their own extension gates; follow Augment's
current [guidelines documentation](https://docs.augmentcode.com/setup-augment/guidelines).

## Connect MCP through the settings panel

Augment's documented custom MCP setup is managed in its Settings Panel or through **Import from
JSON**. The public custom-server docs do not establish generic OAuth or bearer-header authentication
for arbitrary remote MCP servers, so use the local stdio server and LyraShield's user-scoped CLI
credential store with the published packages:

1. On Node.js 24 or later, run `npx -y lyrashield@0.2.14 login --oauth` in the same OS account that
   will run VS Code, then select the intended workspace.
2. Open the Augment panel, open **Settings → MCP → Import from JSON**, and import:

   ```json
   {
     "mcpServers": {
       "lyrashield": {
         "command": "npx",
         "args": ["-y", "@lyrashield/mcp@0.2.12"]
       }
     }
   }
   ```

3. Verify that the server appears in Augment Settings and make a read-only workspace or target-list
   call before treating the connection as active.

The CLI credential remains in LyraShield's local credential store; this configuration contains no
API key. Do not copy over the user's MCP configuration or same-named skills. A scan or retest still
requires explicit user intent and the authorization recorded by LyraShield.

## Official references

- [Augment VS Code skills](https://docs.augmentcode.com/using-augment/skills)
- [Augment VS Code custom commands](https://docs.augmentcode.com/using-augment/custom-commands)
- [Augment guidelines](https://docs.augmentcode.com/setup-augment/guidelines)
- [Augment custom MCP setup](https://docs.augmentcode.com/setup-augment/mcp)

Contracts checked 2026-10-01. Documentation support is not a client-runtime receipt.

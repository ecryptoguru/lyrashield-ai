# LyraShield AI for Augment in JetBrains IDEs

**Native workflow bundle: PREPARATION ONLY.** Augment provides native skills, custom commands, rules
and MCP support in its JetBrains extension. Direct MCP tools can be connected now with the published
CLI `0.2.13` and MCP `0.2.11` baseline shown in the setup wizard; that baseline does not include
these candidate workflow skills. The new workflows require unpublished CLI `0.2.14` and MCP
`0.2.12`. Do not pair the published MCP baseline with candidate skills or install the candidates
until the coordinated release and marketplace export are published and read back. No authenticated
Augment runtime receipt or marketplace listing is confirmed for this IDE surface. This guide is
separate from the Auggie CLI plugin at [`../augment/`](../augment/README.md).

## Install skills and commands

Skills and custom commands are Public Beta opt-ins. Use JetBrains extension **0.428.8 or later**
and enable the relevant features in Augment Settings. After the coordinated release, copy only
selected skill directories from the released marketplace export's `augment/plugins/lyrashield/skills/` to the project
`.augment/skills/` directory. For user scope, use `~/.augment/skills/`. Inspect any same-named
destination first and preserve custom content.

For explicit slash commands, copy selected Markdown files from
`augment/plugins/lyrashield/commands/` into `.augment/commands/` (or `~/.augment/commands/`). The
command files are independent of the skill installation.

Augment's rule renderer uses `.augment/rules/lyrashield.md` for LyraShield-owned project guidance.
Keep this file separate from `.augment-guidelines`, `AGENTS.md`, `CLAUDE.md`, and other user-authored
rules. Rules have a separate JetBrains extension gate; check Augment's current
[guidelines documentation](https://docs.augmentcode.com/setup-augment/guidelines).

## Connect MCP through the settings panel

The documented custom MCP setup is managed in Augment's Settings Panel. The public custom-server
docs do not establish generic OAuth or bearer-header authentication for arbitrary remote MCP
servers, so use the local stdio server and LyraShield's user-scoped CLI credential store after the
candidate packages are published:

1. On Node.js 24 or later, run `npx -y lyrashield@0.2.14 login --oauth` in the same OS account that
   will run the JetBrains IDE, then select the intended workspace.
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

3. Verify the server appears in Augment Settings and make a read-only workspace or target-list
   call before treating the connection as active.

The CLI credential remains in LyraShield's local credential store; this configuration contains no
API key. Preserve the user's other MCP servers and same-named skills. A scan or retest still
requires explicit user intent and the authorization recorded by LyraShield.

## Official references

- [Augment JetBrains skills](https://docs.augmentcode.com/jetbrains/using-augment/skills)
- [Augment JetBrains custom commands](https://docs.augmentcode.com/jetbrains/using-augment/custom-commands)
- [Augment guidelines](https://docs.augmentcode.com/setup-augment/guidelines)
- [Augment JetBrains custom MCP setup](https://docs.augmentcode.com/jetbrains/setup-augment/mcp)

Contracts checked 2026-10-01. Documentation support is not a client-runtime receipt.

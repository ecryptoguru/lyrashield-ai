# LyraShield AI for MiMo Code

**State: PREPARATION.** This JSONC config and shared skills are staged. `@lyrashield/mcp@0.2.12` and CLI `lyrashield@0.2.14` are unpublished candidates; wait for the coordinated release. No authenticated runtime receipt or public listing is confirmed.

Merge the `mcp.lyrashield` block from [`mimocode.jsonc`](./mimocode.jsonc) into project `.mimocode/mimocode.jsonc` or user `~/.config/mimocode/mimocode.jsonc`. The snippet follows MiMo Code's local MCP command-array format. It is not Pi-core configuration. After release, run `npx -y lyrashield@0.2.14 login --oauth` under the same OS user; Node.js 24 or newer is required by the candidate MCP package.

Copy selected skill folders to `.mimocode/skills/<name>/` or `~/.config/mimocode/skills/<name>/`. MiMo Code also discovers `.agents/skills/`. Its native skill workflow is reused; no separate command format is included here.

Verify `mimo mcp` and make a read-only call before asking for a recorded scan. Runtime acceptance remains unverified.

Sources: [official repository](https://github.com/XiaomiMiMo/MiMo-Code), [configuration reference](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/skill/builtin/.bundle/mimocode-docs/reference/config.md), [setup guide](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/skill/builtin/.bundle/mimocode-docs/reference/guide.md), [product docs](https://mimo.mi.com/docs/en-US/updates/feature/mimo-code).

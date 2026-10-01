# LyraShield AI — Cline MCP

Cline connects to LyraShield AI over Streamable HTTP at `https://app.lyrashieldai.com/api/mcp`.

Use `mcp.json` as the server entry for Cline CLI's
`~/.cline/data/settings/cline_mcp_settings.json` or open the IDE extension's settings JSON from
its MCP Servers panel. `CLINE_MCP_SETTINGS_PATH` can override the CLI path. Follow
`llms-install.md` for step-by-step setup.

To submit to the Cline MCP Marketplace, use the issue template at https://github.com/cline/mcp-marketplace.

## Native Agent Skills

This package includes six skills under `skills/<name>/SKILL.md`: `get-started`, `review-changes`,
`scan-project`, `fix-and-retest`, `launch-readiness`, and the backward-compatible `lyrashield` skill.
Each folder and frontmatter `name` match. Per [Cline's skills documentation](https://docs.cline.bot/customization/skills),
Cline discovers skills placed in `.cline/skills/<name>/` for a project or `~/.cline/skills/<name>/`
globally (Windows: `%USERPROFILE%\.cline\skills\`).
Copy only the skills you want from this package, and inspect any same-named destination before
installing so existing skill edits are preserved. Cline's Skills menu (scale icon → **Skills**)
shows discovered skills and lets you enable or disable them; skills can also be invoked from the
chat `/` menu.

The MCP Marketplace entry and the skills are separate installs: the existing Cline MCP listing
does not install this `skills/` directory. Connect the MCP server separately before using skills
that call LyraShield tools. The JSON example above uses an API key; it does not create hosted OAuth
delegation, and hosted write-capable calls may return `connect_required`. Skills do not change MCP
permissions. This is a portable skills bundle, not a Cline executable plugin; Cline's plugin
runtime is limited to its documented SDK, CLI, and Kanban surfaces, while VS Code and JetBrains
use native skills and MCP configuration.

Native skill files are prepared for distribution. Cline component discovery and authenticated
workflow acceptance have not yet been verified against a live Cline client.

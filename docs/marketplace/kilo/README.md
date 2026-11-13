# LyraShield AI Kilo marketplace contribution

This package prepares LyraShield's remote MCP entry and six [Agent Skills](https://kilo.ai/docs/customize/skills)
for Kilo Code. The skills are in `skills/<name>/SKILL.md`: `get-started`, `review-changes`, `scan-project`, `fix-and-retest`,
`launch-readiness`, and the backward-compatible `lyrashield` skill. Each folder name matches its
SKILL.md frontmatter `name`.

## Install skills

Kilo discovers project skills at `.kilo/skills/<name>/SKILL.md` and user skills at
`~/.kilo/skills/<name>/SKILL.md`. It also discovers the standard `~/.agents/skills/` and
`.agents/skills/` locations. On Windows, the global Kilo skills directory is
`%USERPROFILE%\.kilo\skills\`. For team use, copy the chosen skill folders from this package into
the project's `.kilo/skills/` directory and commit them with the project. For personal use, copy
them under the global skills directory. Check for an existing same-named folder first and do not
overwrite local edits. Start a new Kilo session or run `/reload`; discovered skills appear in the
`/` menu's Skills group.

## Connect MCP and authentication

Skills only provide workflow instructions; they do not configure MCP or grant tool permissions.
For a remote server, open **Settings → Agent Behaviour → MCP Servers → Add Server → Remote HTTP**
and use `https://app.lyrashieldai.com/api/mcp`, or configure it under `mcp` in
`~/.config/kilo/kilo.json` or `~/.config/kilo/kilo.jsonc` globally, or in the project's
`kilo.json`, `kilo.jsonc`, `.kilo/kilo.json` or `.kilo/kilo.jsonc`. See
[Kilo's MCP setup guide](https://kilo.ai/docs/automate/mcp/using-in-kilo-code).
Kilo supports OAuth for remote MCP servers when the server advertises it; in the CLI use
`kilo mcp auth lyrashield`. The API-key header example is an alternative hosted API-key path, not
an OAuth delegation. Hosted write-capable calls without an authorized delegated connection may
return `connect_required`, and Kilo's tool permission prompts remain in effect.

The [Kilo Marketplace companion-skill route](https://kilo.ai/docs/customize/marketplace) requires
published archives and a top-level `skills` list in `MCP.yaml`; this manifest now declares the six
bundled skill IDs. Archive publication and the official marketplace packaging/generation flow are
still pending, so automatic companion installation is not available yet. Install the prepared
folders manually until the bundles are released. The files follow Kilo's documented format, but
native loading, OAuth delegation and authenticated workflow acceptance have not yet been verified
against a live Kilo client.

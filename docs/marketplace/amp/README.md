# LyraShield skills for Amp — preparation

This package has five task-specific Amp skills. Each skill carries an `mcp.json` beside its
`SKILL.md`, so Amp can expose only that workflow's LyraShield tools when the skill loads. The
server uses hosted OAuth at `https://app.lyrashieldai.com/api/mcp`; no API key or local process is
embedded in this package.

## Install after marketplace export

The package is prepared in the product source. It is not yet confirmed in a released public
marketplace export. After an immutable export includes `amp/`, clone that exact marketplace
release to a separate directory. Run `amp skill add` from the project where you want the skills
installed, and point it at the package checkout:

```sh
git clone https://github.com/ecryptoguru/lyrashield-marketplace.git /tmp/lyrashield-marketplace
git -C /tmp/lyrashield-marketplace checkout <released-tag-or-commit>
cd /path/to/your/project
amp skill add /tmp/lyrashield-marketplace/amp
```

Amp installs project skills into the current project by default. Add `--global` to install them
only on this machine under `~/.config/agents/skills/`. Confirm discovery with:

```sh
amp skills list
```

An existing Amp thread does not reload just because a separate shell ran `amp skills list`. Use
Amp's `reload_skills` tool or start a new thread, then verify the tools for the invoked skill are
available. Skills are on-demand: Amp sees their names and descriptions first and loads the
instructions and bundled MCP tools when one is invoked.

## Authentication and discovery

The skill `mcp.json` follows Amp's documented shape: a top-level server-name map with `url` and
`includeTools`. The hosted endpoint uses OAuth; complete the sign-in flow when Amp offers it, then
select the intended LyraShield workspace. Each file allowlists only the tools used by that
workflow. Do not add a project API key or bearer header.

Amp gives directly configured servers precedence over a server of the same name bundled in a
skill. A direct `lyrashield` connection can therefore keep the MCP tools visible outside the
on-demand skill. If you want lazy loading, inspect existing personal, workspace, project, and CLI
MCP configuration for a duplicate server before adding this package; change only the duplicate
entry you own.

The skills preserve LyraShield's authorization and evidence boundaries:

- `get-started` selects one accessible workspace, paginates authorized targets, and stays
  read-only.
- `review-changes` uses the local advisory diff tool by default. A recorded Quick scan happens only
  when explicitly requested.
- `scan-project` starts a recorded scan only after an explicit request and authorized target
  selection; it retains the resumable scan or operation ID.
- `fix-and-retest` treats a fix plan as a proposal and reports the trusted retest state as returned.
- `launch-readiness` reads existing release evidence and does not invent missing gates.

## Compatibility evidence and limitations

- Official Amp skills and MCP documentation were checked on 2026-10-01. Amp documents `amp skill
add <source>`, recursive skill discovery, per-skill `mcp.json`, remote HTTP URLs, and OAuth
  handling for supported servers.
- Amp's reviewed docs do not state a minimum client version for local skill `mcp.json` support.
  This package has no authenticated Amp runtime receipt; treat the integration as prepared, not
  runtime-verified. Confirm skill discovery, OAuth, workspace selection, and a read-only call in
  the exact Amp CLI/client version before promoting the support claim.
- This source directory has no independent Amp release number. Pin the immutable marketplace
  release commit and hashes in the channel ledger when export is ready. No marketplace submission
  or publication has been made.
- This package uses hosted HTTP/OAuth and does not require local Node.js. If choosing a separate
  local stdio configuration, LyraShield MCP currently requires Node.js 24 or newer; that fallback
  is outside this package.

Checked against the [Amp Skills documentation](https://ampcode.com/docs/customize/skills) and
[Amp MCP documentation](https://ampcode.com/docs/customize/mcp).

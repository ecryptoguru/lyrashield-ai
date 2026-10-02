# LyraShield AI Gemini CLI extension

PREPARATION ONLY: npm MCP `0.2.12` and CLI `0.2.14` are published, but this extension does not yet
have a matching immutable marketplace release. Do not submit or install it from a public listing
until the exact export is reviewed and released.

The released extension uses the published `@lyrashield/mcp` stdio package and the shared credential
store. Add the `gemini-cli-extension` topic to the public
repository before publishing a release tag, as required by the Gemini CLI gallery.

Use Node.js 24 and run `npx -y lyrashield@0.2.14 login --oauth` first. Leave the extension API-key setting empty to use
that local credential store. The launcher removes inherited credential overrides while preserving
`LYRASHIELD_API_URL`; an optional explicit extension API key uses
`https://app.lyrashieldai.com` only.

MCP 0.2.12 refreshes expired stored OAuth credentials against the stored issuer before the
stdio server starts. An explicit API URL override applies to subsequent LyraShield API calls.

After connecting, call `lyrashield_list_workspaces`, then list an authorized target. If the
credential expires or is revoked, repeat CLI login and restart Gemini. Remove the extension
through Gemini's extension manager; revoke the credential in LyraShield settings when it must no
longer authorize any local client.

## Native commands

The extension bundles two Gemini CLI custom commands in `commands/`:

- `/lyrashield:review-changes` passes the tracked staged and unstaged diff from `HEAD` to the
  local, read-only `lyrashield_check_diff` advisory tool. It excludes untracked files and does not
  start a recorded scan.
- `/lyrashield:scan-project workspaceId=<id> targetId=<id> [mode=QUICK|STANDARD|DEEP]` performs a
  read-only eligibility check, then starts the explicitly requested recorded PR scan on that
  registered target. It defaults to `QUICK` only when workspace and target are explicit; `DEEP`
  must be selected by the user. The scan can consume plan allowance or agent minutes, and the
  command returns its scan ID for resuming status checks.

After installing or updating the extension, restart Gemini CLI so the commands are discovered.
If a project or personal command conflicts, Gemini CLI prefixes the extension command with
`lyrashield-ai.`; use `/lyrashield-ai.lyrashield:review-changes` or
`/lyrashield-ai.lyrashield:scan-project` in that case.

## Native skills

The extension packages the five focused LyraShield workflow skills and the backward-compatible
`lyrashield` skill under `skills/`. Gemini CLI discovers extension skills after installation and
loads each skill only when the user invokes a matching task.

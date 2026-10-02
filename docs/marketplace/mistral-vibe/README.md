# LyraShield AI for Mistral Vibe Code — preparation

**State: PREPARATION.** This bundle contains an additive local stdio MCP snippet and shared Agent Skills. `@lyrashield/mcp@0.2.12` and CLI `lyrashield@0.2.14` are published, but no authenticated Vibe client-runtime receipt or public listing is confirmed.

## Configure the MCP server

Vibe CLI and its VS Code extension share local MCP configuration and sessions. Before adding the block, install the LyraShield CLI, run `lyrashield login` in the same OS account, and use Node.js 24 or newer for the MCP package. Merge [`config/mcp_servers.toml`](./config/mcp_servers.toml) into either the trusted project `./.vibe/config.toml` or user `~/.vibe/config.toml`; do not replace an existing configuration. The stdio server reads the CLI credential store, so no key or bearer token is embedded.

Keep Vibe's tool approval controls enabled. The workflow skills require explicit user intent before scans and mutations; do not configure mutating tools with `permission = "always"`. Verify discovery in Vibe's `/mcp` view, then make a read-only workspace/target lookup before claiming the integration works.

## Install the skills

Copy each `skills/<name>/` directory to the project's `.vibe/skills/<name>/` for trusted project scope, or to `~/.vibe/skills/<name>/` for user scope. Alternatively, add the absolute path to this bundle's `skills/` directory to the `skill_paths` array in Vibe's TOML configuration. `user-invocable: true` makes these skills available as slash commands. Use `/reload` or start a new session after installation.

Project config is loaded only for a trusted working directory. Organization-managed config may override local values; check `/config` when a server or skill does not appear. The package contains no hooks and no public marketplace listing is asserted; use versioned direct distribution until an official contribution route is verified.

## Included workflows

`get-started`, `review-changes`, `scan-project`, `fix-and-retest`, and `launch-readiness` use existing LyraShield MCP operations. They preserve the read-only default, explicit scan intent, idempotent retries, resumable IDs, and returned evidence states.

## Verification and sources

Official docs checked 2026-10-01: [Vibe configuration](https://docs.mistral.ai/vibe/code/cli/configuration), [configuration reference](https://docs.mistral.ai/vibe/code/cli/configuration-reference), [skills](https://docs.mistral.ai/vibe/code/cli/skills), [MCP servers](https://docs.mistral.ai/vibe/code/cli/mcp-servers), and [CLI/VS Code/Web surfaces](https://docs.mistral.ai/vibe/code/choose-cli-vscode-web-sessions). These docs confirm the setup formats, not LyraShield runtime acceptance. No Vibe package marketplace submission or publication has been made.

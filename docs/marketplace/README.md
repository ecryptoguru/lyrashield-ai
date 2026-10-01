# LyraShield AI marketplace release source

PREPARATION ONLY: Agent Plugin `0.1.31`, MCP `0.2.12`, and CLI `0.2.14` are local
release candidates and have not been published. This marketplace export must not be installed
from a released listing until the coordinated npm and marketplace release is reviewed.
Channel-specific listing versions and review states may lag this source.

## Install from this repository

This repository is an addressable plugin marketplace: `.claude-plugin/marketplace.json` catalogs the
root plugin with `source: "./"`, so the marketplace root and the plugin root are the same directory.

Claude Code marketplace commands:

```shell
claude plugin marketplace add ecryptoguru/lyrashield-marketplace
claude plugin install lyrashield@lyrashield-ai
```

GitHub Copilot CLI uses the same marketplace identity through its own commands:

```shell
copilot plugin marketplace add ecryptoguru/lyrashield-marketplace
copilot plugin install lyrashield@lyrashield-ai
```

VS Code: run **Chat: Install Plugin From Source** from the Command Palette and paste
`https://github.com/ecryptoguru/lyrashield-marketplace`. To make adoption a repo-committed team
decision instead, add this to `.claude/settings.json` or `.github/copilot/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "lyrashield-ai": {
      "source": { "source": "github", "repo": "ecryptoguru/lyrashield-marketplace" }
    }
  },
  "enabledPlugins": { "lyrashield@lyrashield-ai": true }
}
```

Neither marketplace path inlines a credential. Their remote MCP connection completes hosted OAuth
inside the client. The Kiro stdio adapter is the path that reads
`~/.lyrashield/credentials.json` after `npx -y lyrashield@0.2.14 login --oauth`.

For local stdio clients (Kiro, Gemini CLI, Zed and Codebuff), use Node.js 24 and run the pinned
CLI login command above before starting the client. Select one workspace in the browser. First
call `lyrashield_list_workspaces`, then `lyrashield_list_targets` for an authorized target. If
authorization expires or is revoked, repeat the CLI login and restart the client. Hosted HTTP
clients complete OAuth inside their connection UI. Keep API keys in user-level settings, never a
committed project file or agent prompt.

LyraShield is not yet listed in a published VS Code plugin marketplace, so there is no one-click
marketplace install for VS Code today. Install-from-source and the marketplace-by-URL paths above
install the same plugin.

## Release boundary

The installable client boundary is the exported root `plugin.json`, OAuth-first `mcp.json`,
`skills/` and generated client shims. It is Apache-2.0; the hosted dashboard, worker and engine
remain proprietary. The OpenClaw directory additionally carries its narrow MIT-0 grant.
The release job must export only these files to the dedicated public `lyrashield-marketplace`
repository:

- root `plugin.json`, `mcp.json`, `skills/`, client shims and client adapters
- native bundles for Gemini CLI, Kiro, Cline, Kilo, OpenClaw, Zed, Codebuff, Amp, OpenCode,
  Antigravity, Augment, Factory, Qoder, Qwen, Devin, JetBrains, Goose, Hermes, Pi Core and other
  documented client surfaces
- official MCP Registry `server.json` and its vendored schema/provenance
- marketplace icons, screenshots, changelog, support/privacy/terms links and test fixtures

The export must not contain `.env` files, credentials, database schema, customer data, hosted
service source or generated build caches. Run
`pnpm --filter @lyrashield/agent-plugin export:marketplace /path/to/export` to create the
deterministic release boundary. `manifest.json` records the source package, version, generated
files and forbidden hosted-service paths; the export test fails if an artifact disappears.

The export includes native artifacts from each supported client wave. Listing applications remain
separate; the [channel ledger](./channels.md) records the verified intake route, package identity,
public state and remaining evidence for each one. The Gemini repository must additionally carry
the `gemini-cli-extension` topic.

## Submission order

1. Founder/counsel approval of `/privacy`, `/terms`, `/support` and the security-reporting mailbox.
2. Create and verify the LyraShield AI publisher identity and sanitized reviewer workspace.
3. Export and tag the public repository with an immutable version.
4. Smoke-test OAuth connect, workspace selection, read-only MCP calls, delegated idempotent writes,
   out-of-grant denial, legacy approval, pause, forced expiry, permission loss, refresh/reconnect,
   disconnect/revocation, CLI API-key fallback, Zed, Codebuff and the generated marketplace fixtures.
5. Submit the shared listing to OpenAI/Codex, Claude, Cursor, Kiro, Cline, Kilo, Zed, Codebuff,
   Gemini CLI and ClawHub according to each channel's current intake. Verify GitHub Copilot through
   its plugin marketplace path; Awesome Copilot is not a product-listing channel.

Marketplace availability is claimed only for channels with a visible public listing, never merely a
submitted application. Direct adapter guides remain available for clients without a verified
marketplace program.

## Submission tracking

Public channel states were last checked on 2026-10-01. Private publisher dashboards remain
`UNKNOWN` unless there is a current authenticated readback. See the [distribution channel ledger](./channels.md)
for the current public links, versions, evidence, and next step for each channel. Directory status
does not establish client compatibility.

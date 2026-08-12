# LyraShield AI marketplace release source

## Install from this repository

This repository is an addressable plugin marketplace: `.claude-plugin/marketplace.json` catalogs the
root plugin with `source: "./"`, so the marketplace root and the plugin root are the same directory.

Clients with marketplace commands:

```
/plugin marketplace add ecryptoguru/lyrashield-marketplace
/plugin install lyrashield@lyrashield-ai
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

Neither path inlines a credential. Run `lyrashield login --oauth` once per machine; the MCP server
reads the selected workspace credential from `~/.lyrashield/credentials.json`.

LyraShield is not yet listed in a published VS Code plugin marketplace, so there is no one-click
marketplace install for VS Code today. Install-from-source and the marketplace-by-URL paths above
install the same plugin.

## Release boundary

The installable client boundary is the exported root `plugin.json`, OAuth-first `mcp.json`,
`skills/`, and generated client shims. It is Apache-2.0; the hosted dashboard, worker, and engine
remain proprietary. The OpenClaw directory additionally carries its narrow MIT-0 grant.
The release job must export only these files to the dedicated public `lyrashield-marketplace`
repository:

- root `plugin.json`, `mcp.json`, `skills/`, client shims, and client adapters
- Zed extension and Codebuff agent sources
- marketplace icons, screenshots, changelog, support/privacy/terms links, and test fixtures

The export must not contain `.env` files, credentials, database schema, customer data, hosted
service source, or generated build caches. Run
`pnpm --filter @lyrashield/agent-plugin export:marketplace /path/to/export` to create the
deterministic release boundary. `manifest.json` records the source package, version, generated
files, and forbidden hosted-service paths; the export test fails if an artifact disappears.

The export also contains the native/review artifacts used by the first submission wave:
Gemini CLI, Kiro Power, Cline, Kilo, OpenClaw, Zed, Codebuff, a 400×400 icon, and the sanitized
reviewer pack. The Gemini repository must additionally carry the `gemini-cli-extension` topic.

## Submission order

1. Founder/counsel approval of `/privacy`, `/terms`, `/support`, and the security-reporting mailbox.
2. Create and verify the LyraShield AI publisher identity and sanitized reviewer workspace.
3. Export and tag the public repository with an immutable version.
4. Smoke-test OAuth connect, workspace selection, read-only MCP calls, denied writes, pending approval,
   disconnect/revocation, CLI API-key fallback, Zed, Codebuff, and the generated marketplace fixtures.
5. Submit the shared listing to OpenAI/Codex, Claude, Cursor, Kiro, Cline, Kilo, Zed, Codebuff,
   Gemini CLI, and ClawHub according to each channel's current intake. Verify GitHub Copilot through
   its direct Agent Plugin install path; Awesome Copilot is not a product-listing channel.

Marketplace availability is claimed only for channels with a visible public listing, never merely a
submitted application. Direct adapter guides remain available for clients without a verified
marketplace program.

## Submission tracking

Last checked: 2026-08-12.

- GitHub Copilot: direct Agent Plugin install is supported. The [Awesome Copilot submission #2592](https://github.com/github/awesome-copilot/issues/2592) was rejected as a product-marketing submission; do not resubmit it.
- Cline: [issue #2213](https://github.com/cline/mcp-marketplace/issues/2213) is open with no maintainer decision.
- Kilo: [PR #217](https://github.com/Kilo-Org/kilo-marketplace/pull/217) is open and awaiting maintainer review.
- Zed: [PR #7149](https://github.com/zed-industries/extensions/pull/7149) is open; package, Danger, and CLA checks pass after the capability fix, and it awaits maintainer re-review. The extension now uses only Zed's `npm:install` capability after the `process:exec` capability was removed as unnecessary.
- Gemini CLI: the public repository has the `gemini-cli-extension` topic and a public `v0.1.14` release.
- OpenClaw: [ClawHub listing](https://clawhub.ai/ecryptoguru/skills/lyrashield) is published as a community listing; it is not an official OpenClaw channel.
- Kiro: submitted; its reviewer state is not publicly exposed.
- Claude: [plugin submissions](https://platform.claude.com/plugins/submissions) show two LyraShield AI submissions pending review.
- Codebuff: the [LyraShield AI publisher](https://codebuff.com/publishers/lyrashield) has a public,
  unverified `0.1.1` listing with the MCP declaration live.
- Cursor: the [LyraShield AI publisher application](https://cursor.com/marketplace/publish) is submitted and awaiting review. The generated Cursor shim is OAuth-first (no raw API-key variable in the plugin manifest).
- OpenAI/Codex: LyraShield AI `0.1.10` is in review.

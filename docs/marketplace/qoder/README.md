# LyraShield AI for Qoder — preparation

This folder contains a Qoder plugin package plus a Qoder CLI user-hosted marketplace manifest. The
plugin uses the documented `.qoder-plugin/plugin.json`, conventional `skills/`, `commands/`, and
`.mcp.json` component paths. Its five skill files are canonical copies from
`packages/agent-plugin/plugin/skills/`; the source-checkout maintainer validator checks manifest
shape and byte parity before export. Maintainer validators are omitted from the public marketplace
export.

The plugin and marketplace `0.1.0` values are preparation metadata, not released identities. Bind
the exact reviewed artifact version and source commit during release preparation.

## Maintainer staging review only

The following local package commands are for maintainer review of unpublished preparation
artifacts only. They are not current customer install recommendations. Do not use the mutable
marketplace default branch as an install source. Customer plugin instructions require a reviewed
matching immutable release; use the current client-specific direct MCP guide meanwhile.

Qoder CLI documents adding a local marketplace source. From the product repository:

```sh
qoder plugins marketplace add ./docs/marketplace/qoder
qoder plugins marketplace list
```

Use the marketplace name reported by Qoder when installing `lyrashield`. Marketplace commands are
feature-flagged in some Qoder deployments. CLI project/local MCP scope also depends on project trust
and approval settings.

## Qoder IDE local import

Qoder IDE documents importing a local plugin folder and uploading a plugin ZIP. Import
`docs/marketplace/qoder/plugins/lyrashield` through **Extensions → Plugins → Add Plugins → Upload
Plugin** after packaging that directory as a ZIP. This artifact has not been tested in either Qoder
IDE or Qoder CLI; verify component discovery and MCP behavior separately for each client surface.

## Authentication and limits

The MCP config uses the documented HTTP transport and requests only `lyrashield.read`. Qoder CLI
documents browser-based OAuth for remote MCP. Qoder IDE supports plugin-bundled MCP but its current
public package docs do not establish that it uses the same OAuth path. Complete authentication,
verify the intended workspace, and make a read-only call before relying on the integration. Scan,
fix-proposal, and retest tools require explicit user intent and the appropriate LyraShield OAuth
connection, workspace membership, and delegated authorization. No hooks or automatic scans are
installed.

## Distribution status

**PREPARATION** — Qoder documents user-hosted CLI marketplaces and local IDE imports. Its curated
marketplace is described as editor-curated; a public third-party submission intake could not be
verified. No public LyraShield listing, submission, or authenticated client runtime receipt exists.

Official references checked 2026-10-01:

- [Qoder CLI plugin reference](https://docs.qoder.com/cli/plugins-reference)
- [Qoder CLI MCP reference](https://docs.qoder.com/cli/mcp-reference)
- [Qoder IDE plugins](https://docs.qoder.com/extensions/plugins)
- [Qoder custom extension publishing](https://docs.qoder.com/qoder/extension-publishing)

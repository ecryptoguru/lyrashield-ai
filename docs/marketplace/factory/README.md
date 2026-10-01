# LyraShield AI for Factory Droid — preparation

This is a Droid-native plugin and user-hosted marketplace package. It follows Factory's
`.factory-plugin/marketplace.json`, `.factory-plugin/plugin.json`, `skills/`, `commands/` and root
`mcp.json` layout. The five workflow skills are copied from
`packages/agent-plugin/plugin/skills/`; the source-checkout maintainer validator verifies their
content against the canonical source before export. Maintainer validators are omitted from the
public marketplace export.

The plugin has a `0.1.0` preparation version only; it is not a published release identity. Bind the
exact reviewed artifact and source commit when preparing a release.

## Local review and install

Factory documents local marketplaces for testing. From the product repository:

```sh
droid plugin marketplace add ./docs/marketplace/factory
droid plugin marketplace list
```

Use the marketplace name returned by that command:

```sh
droid plugin install lyrashield@<registered-marketplace-name> --scope user
droid plugin list --scope user
```

After a released marketplace export is available in a Git repository, add that exact repository
using the documented `droid plugin marketplace add <source>` command. Factory's public docs confirm
custom and internal marketplaces; they do not establish an application to a separate curated public
directory for this plugin.

## Authentication and workflow limits

The bundled hosted Streamable HTTP configuration requests only `lyrashield.read`; Factory documents
OAuth Dynamic Client Registration and stores OAuth credentials in the system keyring (or a fallback
file). Complete consent in the client, verify the intended workspace and make a read-only call.
Scan, proposal, and retest workflows require the user's explicit request plus a LyraShield connection
and workspace authorization that permits the operation. Do not expand consent by editing config
alone. No hooks or automatic scans are installed.

## Status

**PREPARATION** — plugin shape matches the current Factory contract, but no Droid client runtime
receipt, marketplace release, public listing, or listing readback exists. An installed plugin badge
does not prove MCP authentication or tool behavior. From the LyraShield AI source checkout, run
`node docs/marketplace/factory/validate.mjs` for the offline manifest and skill-copy check.

Official references checked 2026-10-01:

- [Factory plugins and marketplaces](https://docs.factory.ai/harness/plugins)
- [Factory MCP and OAuth](https://docs.factory.ai/harness/mcp)

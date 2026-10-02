# LyraShield AI for Google Antigravity

This is the Antigravity-native plugin package. Its `plugin.json` follows Google's strict plugin
manifest, `mcp_config.json` uses Antigravity's `serverUrl` transport field and hosted OAuth
discovery, and `skills/` contains LyraShield's shared workflows. Keep these files distinct from
the portable Agent Plugins `plugin.json` and `mcp.json` at the marketplace root; Antigravity does
not consume that MCP format directly.

## Maintainer staging review only

The following local package commands are for maintainer review of unpublished preparation
artifacts only. They are not current customer install recommendations. Do not use the mutable
marketplace default branch as an install source. Customer plugin instructions require a reviewed
matching immutable release; use the current client-specific direct MCP guide meanwhile.

The current plugin documentation lists Antigravity 2.0, Antigravity CLI and Antigravity IDE.
This package has not yet completed authenticated runtime acceptance on those surfaces. The CLI
path installs the package directory:

```sh
agy plugin install /path/to/marketplace-export/antigravity
agy plugin list
```

In the interactive CLI, run `/plugin`, choose **Install from local directory**, then select this
package directory. In Antigravity 2.0, inspect **Customizations → Marketplace** for curated
plugins; this LyraShield package is not listed there yet. For standalone IDE manual installation,
place the directory under `.agents/plugins/lyrashield/` for the current workspace or
`~/.gemini/config/plugins/lyrashield/` globally. Review an existing destination before replacing
it so local customizations remain intact.

After installation, inspect the plugin details and confirm both skills and the LyraShield MCP
server are listed. Check `/mcp` for a connected server, complete Antigravity's OAuth flow, select
one LyraShield workspace, then make a read-only workspace or target-list call. An installed badge
or staged directory alone does not prove authentication or tool access.

The packaged remote endpoint supports OAuth dynamic client registration; no API key or credential
is included in these files. Antigravity's permission system governs MCP tool calls. The default
LyraShield OAuth connection is read-only; any delegated writes remain bound to the recorded
connection grant. The bundled skills require explicit user intent before scans or retests and
preserve incomplete evidence states. No hooks or background scans are installed.

To remove a CLI-installed plugin, run `agy plugin uninstall lyrashield`; in the TUI use the
Installed tab. For manual installs, remove only the LyraShield-owned plugin directory after
checking that it contains no local user changes. Revoke LyraShield OAuth access separately when
the connection should no longer authorize requests.

## Marketplace state

**PREPARATION** — the current Marketplace documentation links an official plugin-interest form,
but the form's application details and eligibility could not be verified here. No application was
submitted and no public LyraShield listing was read back. Do not describe the package as
marketplace-available until a listing is published and verified.

## Privacy and support

Review LyraShield's [Privacy Policy](https://lyrashieldai.com/privacy) and [Support](https://lyrashieldai.com/support).
Security reports use the separately published security-reporting address. This client tooling is
Apache-2.0; the hosted LyraShield service remains proprietary.

## Official references

- [Antigravity plugin format and installation](https://antigravity.google/docs/plugins)
- [Antigravity MCP configuration and OAuth](https://antigravity.google/docs/mcp)
- [Antigravity Marketplace and interest form](https://antigravity.google/docs/marketplace)
- [Marketplace interest form](https://forms.gle/2EX5RFYPoJe1UgxR9) — not submitted

Contract checked 2026-10-01. Documentation support is not a runtime receipt.

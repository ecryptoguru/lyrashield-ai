# LyraShield AI for Kiro

PREPARATION ONLY: this Power uses the unpublished CLI `0.2.14` release candidate. Do not submit
or install it from a public listing until the coordinated release is published.

This folder is a self-contained Kiro Power in the current Agent Plugins format. It includes
`plugin.json`, OAuth-backed `mcp.json`, and the shared LyraShield skills. Import this folder as a
custom Power for local testing. For a GitHub import or publisher submission, use the marketplace
repository root, which also contains the portable package at its root; do not submit this nested
folder URL as though Kiro supported arbitrary repository subpaths.

## Install on current Kiro

Kiro Powers are supported in the IDE and Web; the Kiro CLI supports them starting with CLI v3.
Cloud-synced Powers appear in Kiro IDE 1.0.437 and later. The local custom-Power flow has no
published minimum version in the current documentation, so verify that your client exposes the
Powers import flow before relying on it.

In Kiro, open the **Powers** panel, choose **Add Custom Power**, and import from GitHub or a local
folder. For local import, select this folder. For the public GitHub flow, import the repository
root after the matching release is published. Kiro installs the package components together and
activates them on relevant tasks; the plugin descriptor by itself is not proof that the Power or
its MCP server is installed.

After import, confirm the Power appears in Kiro's installed Powers list and that its LyraShield
MCP tools appear when the Power is active. The packaged remote Streamable HTTP endpoint uses
Kiro's hosted OAuth flow. Complete the connection, select one workspace, and make a read-only
workspace or target-list call before relying on the integration. Local configuration or an
`INSTALLED` label alone does not prove the MCP server connected.

The included skills activate for their matching workflows. They keep scans explicit, select the
least intensive requested profile, preserve incomplete evidence states, and require trusted
retest evidence before describing a fix as validated. No hook starts scans or paid work.

## Older-client compatibility

If the installed Kiro version does not offer Power import/activation, use the legacy local stdio
MCP route. It requires Node.js 24 or later. First run:

```sh
npx -y lyrashield@0.2.14 login --oauth
```

Then merge only the `lyrashield` server object from the marketplace root's `.mcp.kiro.json` into
the existing workspace `.kiro/settings/mcp.json` or user `~/.kiro/settings/mcp.json`. Preserve all
other servers and file content. Restart/reload the Kiro MCP connection and verify the server in
Kiro's MCP status view before calling a tool. The stdio adapter reads the CLI's local credential
store; never place the credential in MCP JSON or a shared project file.

The generated `.kiro-plugin/plugin.json` shim is metadata for the older plugin adapter. Staging
that directory, copying it into the workspace, or running CLI login alone does not register an
MCP server. The actual legacy activation step is merging `.mcp.kiro.json` into Kiro's MCP settings.

To remove the current Power, uninstall it through Kiro's Powers UI. For the legacy route, remove
only the `lyrashield` entry you added from Kiro MCP settings. Revoke LyraShield OAuth access
separately if you no longer want that connection to authorize requests.

## Privacy and support

Only data required for the selected workspace operation is sent to LyraShield. Review the
[Privacy Policy](https://lyrashieldai.com/privacy) and [Support](https://lyrashieldai.com/support)
for service-side data handling. Security reports use the separately published
security-reporting address.

This Power is Apache-2.0 client tooling; the hosted LyraShield service remains proprietary.

## Official Kiro references

- [Powers overview](https://kiro.dev/docs/powers/)
- [Create and share Powers](https://kiro.dev/docs/powers/create/)
- [MCP configuration](https://kiro.dev/docs/mcp/)
- [Publisher requirements](https://kiro.dev/powers/submit/)

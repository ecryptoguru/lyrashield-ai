# LyraShield AI Kiro Power

Submit this directory with the generated `.kiro-plugin/plugin.json`. Test OAuth connection,
workspace selection, read-only calls, delegated writes executing within the connection grant and
`connect_required` responses for non-OAuth writes in a sanitized demo workspace before submission.

Kiro discovers workspace servers in `.kiro/settings/mcp.json` and user servers in `~/.kiro/settings/mcp.json`. Merge the `lyrashield` entry from the exported `.mcp.kiro.json` into one of those files, preserving existing servers. Run `npx -y lyrashield@0.2.12 login --oauth` first. The plugin shim alone does not establish discovery.

Use Node.js 24. After restart, call `lyrashield_list_workspaces` and list an authorized target.
Repeat CLI login if the stored credential expires or is revoked. To remove the integration, delete
only the `lyrashield` entry from Kiro MCP settings. Revoke the shared credential only when it is no
longer needed by other local clients.

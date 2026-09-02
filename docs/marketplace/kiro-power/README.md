# LyraShield AI Kiro Power

Submit this directory with the generated `.kiro-plugin/plugin.json`. Test OAuth connection,
workspace selection, read-only calls, denied writes, and approval polling in a sanitized demo
workspace before submission.

Kiro discovers workspace servers in `.kiro/settings/mcp.json` and user servers in `~/.kiro/settings/mcp.json`. Merge the `lyrashield` entry from the exported `.mcp.kiro.json` into one of those files, preserving existing servers. Run `lyrashield login --oauth` first. The plugin shim alone does not establish discovery.

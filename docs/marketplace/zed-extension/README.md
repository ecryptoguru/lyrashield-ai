# LyraShield AI Zed extension

This extension registers the hosted LyraShield MCP context server in Zed. It launches the
published `@lyrashield/mcp` package with the base API URL; authenticate interactively with
`lyrashield login --oauth`, or use the shared API-key credential fallback for CI.

The default connection is read-only and bound to one workspace. Write-capable actions require
the LyraShield write scope and the exact-argument approval gate. The dashboard remains the
source of truth for evidence and approvals.

Client source is Apache-2.0. Hosted LyraShield service code is not included.

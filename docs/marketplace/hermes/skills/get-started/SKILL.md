---
name: get-started
description: "Connect LyraShield, choose a workspace and inspect authorized targets."
---

# Get started

Use this workflow when the user asks to connect LyraShield, check access or find a target.

1. Call `lyrashield_list_workspaces` and let the user choose a workspace unless the active client already supplies one and a LyraShield response confirms it.
2. Call `lyrashield_list_targets` with the selected `workspaceId`. Follow `nextCursor` with `cursor` until it is absent before claiming the target list is complete.
3. Use only a target returned for that workspace. Explain that configuration on disk does not prove the client loaded the server; verify with the client's MCP status or tool list.
4. Explain hosted OAuth and local stdio/API-key options using the client’s current setup instructions. Never request, print or store a secret in a shared config file.

This workflow is read-only. Do not start scans or change target, workspace, billing or authorization state.

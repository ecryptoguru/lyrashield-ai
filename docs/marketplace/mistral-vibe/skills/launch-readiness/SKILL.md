---
user-invocable: true
name: launch-readiness
description: "Read LyraShield release readiness evidence and explain missing gates."
---

# Launch readiness

Use this workflow only when the user asks whether a registered target is ready for a release.

1. Resolve the selected workspace and authorized target. Call `lyrashield_get_launch_readiness` with `workspaceId` and `targetId`.
2. Bind the query to the supplied release commit or artifact digest when available. A readiness result is enforceable only when it matches the release identity.
3. Explain each returned gate and evidence state. Identify missing or stale evidence as unresolved; do not fill gaps from assumptions or a clean advisory diff.
4. Keep operational readiness separate from a security guarantee, certification, compliance claim, or proof that every vulnerability was detected.

This workflow is read-only. It does not start a scan, deploy an artifact, or change a release gate.

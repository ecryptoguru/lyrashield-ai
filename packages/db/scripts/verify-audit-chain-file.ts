import { readFileSync } from "node:fs"
import { computeAuditHash, verifyAuditChain } from "../src/audit-hash"

const file = process.argv[2]
if (!file) throw new Error("Usage: verify-audit-chain-file.ts <audit-json-file>")

const parsed: unknown = JSON.parse(
  readFileSync(file, "utf8") // eslint-disable-line security/detect-non-literal-fs-filename -- operator-supplied restore artifact
)
if (!Array.isArray(parsed)) throw new Error("Audit export must be a JSON array")

const entries = parsed.map((entry) => {
  if (!entry || typeof entry !== "object") throw new Error("Audit export contains an invalid row")
  const record = entry as Record<string, unknown>
  return { ...record, createdAt: new Date(String(record.createdAt)) }
})

// The restore export contains all workspaces, each with an independent chain.
// Preserve the export's chronological order within each workspace.
const workspaceChains = new Map<string, Parameters<typeof verifyAuditChain>[0]>()
for (const entry of entries as Parameters<typeof verifyAuditChain>[0]) {
  if (typeof entry.workspaceId !== "string" || !entry.workspaceId) {
    throw new Error("Audit export contains an invalid workspace ID")
  }
  const chain = workspaceChains.get(entry.workspaceId) ?? []
  chain.push(entry)
  workspaceChains.set(entry.workspaceId, chain)
}
for (const [workspaceIndex, chain] of [...workspaceChains.values()].entries()) {
  if (!verifyAuditChain(chain)) {
    let previousHash: string | null = null
    for (const [entryIndex, entry] of chain.entries()) {
      if (entry.prevHash !== previousHash) {
        throw new Error(
          `Restored audit chain verification failed: workspace ${workspaceIndex + 1}, entry ${entryIndex + 1}, predecessor mismatch`
        )
      }
      if (entry.hash?.startsWith("v2:") && entry.hash !== computeAuditHash(entry, entry.prevHash)) {
        throw new Error(
          `Restored audit chain verification failed: workspace ${workspaceIndex + 1}, entry ${entryIndex + 1}, content hash mismatch`
        )
      }
      previousHash = entry.hash
    }
    throw new Error(
      `Restored audit chain verification failed: workspace ${workspaceIndex + 1}, legacy content hash mismatch`
    )
  }
}

console.log(`Verified ${entries.length} restored audit log entries`)

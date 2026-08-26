import { readFileSync } from "node:fs"
import { verifyAuditChain } from "../src/audit-hash"

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

if (!verifyAuditChain(entries as Parameters<typeof verifyAuditChain>[0])) {
  throw new Error("Restored audit chain verification failed")
}

console.log(`Verified ${entries.length} restored audit log entries`)

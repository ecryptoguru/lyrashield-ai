import {
  parsePostgresConnectionTarget,
  canonicalSupabaseDatabaseIdentity,
  hashDatabaseIdentity,
} from "./webhook-empty-state-contract.mjs"
// Compatibility normalization applies ONLY to this documented driver option.
// URI/query endpoint overrides, duplicate/encoded keys and unsafe TLS modes
// still go through the shared strict parser before returning a dump target.
export function normalizeBackupConnection(raw) {
  const url = new URL(raw),
    found = []
  for (const [name, value] of url.searchParams) if (name === "uselibpqcompat") found.push(value)
  if (found.length > 1 || found.some((value) => !["1", "true"].includes(value)))
    throw new Error("Unsupported backup compatibility option")
  url.searchParams.delete("uselibpqcompat")
  const sanitized = url.href
  const target = parsePostgresConnectionTarget(sanitized, "backup database URL")
  if (target.port !== "5432") throw new Error("Backup requires direct/session PostgreSQL")
  return {
    url: sanitized,
    identitySha256: hashDatabaseIdentity(canonicalSupabaseDatabaseIdentity([sanitized])),
  }
}

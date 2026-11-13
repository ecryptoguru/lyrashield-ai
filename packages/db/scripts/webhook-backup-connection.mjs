import {
  assertSupabaseDatabasePrincipal,
  parsePostgresConnectionTarget,
  canonicalSupabaseDatabaseIdentity,
  hashDatabaseIdentity,
} from "./webhook-empty-state-contract.mjs"
// libpq does not understand this Node-only flag. Normalize it only for backup
// observation; the shared parser still owns TLS, principal and target checks.
export function normalizeBackupConnection(raw) {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 8192)
    throw new Error("backup database URL is missing or invalid")
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error("backup database URL is not a valid PostgreSQL URL")
  }
  const compatibility = url.searchParams.getAll("uselibpqcompat")
  if (compatibility.length > 1 || compatibility.some((value) => !["1", "true"].includes(value)))
    throw new Error("Unsupported backup compatibility option")
  url.searchParams.delete("uselibpqcompat")
  const normalized = url.href
  const target = parsePostgresConnectionTarget(normalized, "backup database URL")
  if (target.port !== "5432") throw new Error("Backup requires direct/session PostgreSQL")
  // Preserve the pre-existing backup-only principal contract. Runtime role
  // flexibility must not silently broaden backup authorization.
  assertSupabaseDatabasePrincipal(normalized, "postgres", "backup database URL")
  return {
    url: target.url.href,
    identitySha256: hashDatabaseIdentity(canonicalSupabaseDatabaseIdentity([normalized])),
  }
}

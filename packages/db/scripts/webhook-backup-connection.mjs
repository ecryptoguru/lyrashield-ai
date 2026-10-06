import {
  assertSupabaseDatabasePrincipal,
  parsePostgresConnectionTarget,
  canonicalSupabaseDatabaseIdentity,
  hashDatabaseIdentity,
} from "./webhook-empty-state-contract.mjs"
// Backup observation uses the raw target only for identity and credential
// continuity. Unknown driver options are rejected instead of normalized away.
export function normalizeBackupConnection(raw) {
  const target = parsePostgresConnectionTarget(raw, "backup database URL")
  if (target.port !== "5432") throw new Error("Backup requires direct/session PostgreSQL")
  // Preserve the pre-existing backup-only principal contract. Runtime role
  // flexibility must not silently broaden backup authorization.
  assertSupabaseDatabasePrincipal(raw, "postgres", "backup database URL")
  return {
    url: target.url.href,
    identitySha256: hashDatabaseIdentity(canonicalSupabaseDatabaseIdentity([raw])),
  }
}

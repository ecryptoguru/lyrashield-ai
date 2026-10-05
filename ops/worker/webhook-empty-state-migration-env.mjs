import { constants, openSync, fstatSync, readFileSync, closeSync } from "node:fs"
import { checkParents } from "../../packages/db/scripts/webhook-empty-state-root-store.mjs"
import {
  assertMigrationUrlBinding,
  canonicalSupabaseDatabaseIdentity,
  hashDatabaseIdentity,
  parsePostgresConnectionTarget,
} from "../../packages/db/scripts/webhook-empty-state-contract.mjs"
import { requireValue } from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"
export function parseFixedMigrationEnvironment(bytes, expectedIdentity) {
  requireValue(
    typeof bytes === "string" && bytes.length <= 65536,
    "Invalid fixed migration environment"
  )
  const values = {}
  for (const line of bytes.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    requireValue(
      match &&
        [
          "DATABASE_DIRECT_URL",
          "DATABASE_URL",
          "MIGRATION_DATABASE_URL",
          "PRODUCTION_DATABASE_DIRECT_URL",
        ].includes(match[1]) &&
        !Object.hasOwn(values, match[1]),
      "Unexpected or duplicate fixed environment field"
    )
    requireValue(!/\r|\0/.test(match[2]), "Invalid fixed environment value")
    values[match[1]] = match[2]
  }
  const direct = values.DATABASE_DIRECT_URL
  const env = { DATABASE_DIRECT_URL: direct, DATABASE_URL: values.DATABASE_URL || direct }
  assertMigrationUrlBinding(env)
  requireValue(
    parsePostgresConnectionTarget(direct).port === "5432" &&
      hashDatabaseIdentity(canonicalSupabaseDatabaseIdentity([direct])) === expectedIdentity,
    "Migration connection differs from approved direct/session target"
  )
  if (values.MIGRATION_DATABASE_URL)
    requireValue(values.MIGRATION_DATABASE_URL === direct, "Migration alias changed")
  return env
}
export function loadFixedMigrationEnvironment(expectedIdentity) {
  const path = "/etc/lyrashield/webhook-empty-state.env"
  checkParents(path)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    requireValue(
      stat.isFile() &&
        stat.uid === 0 &&
        (stat.mode & 0o777) === 0o600 &&
        stat.nlink === 1 &&
        stat.size <= 65536,
      "Unsafe fixed migration environment"
    )
    return parseFixedMigrationEnvironment(readFileSync(fd, "utf8"), expectedIdentity)
  } finally {
    closeSync(fd)
  }
}

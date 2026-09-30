import { createHash } from "node:crypto"
export function migrationDatabaseIdentity(value) {
  try {
    const url = new URL(value)
    const database = decodeURIComponent(url.pathname.slice(1))
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      !["", "5432", "6432"].includes(url.port) ||
      !database
    )
      throw new Error()
    return createHash("sha256")
      .update(
        JSON.stringify([
          url.hostname.toLowerCase(),
          database,
          url.searchParams.get("schema") || "public",
        ])
      )
      .digest("hex")
  } catch {
    throw new Error(
      "Migration database configuration requires a valid PostgreSQL host, database and schema"
    )
  }
}
if (process.argv[1]?.endsWith("migration-database-identity.mjs")) {
  try {
    console.log(migrationDatabaseIdentity(process.env.MIGRATION_DATABASE_URL))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

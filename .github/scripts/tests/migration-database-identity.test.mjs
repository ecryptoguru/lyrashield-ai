import assert from "node:assert/strict"
import test from "node:test"
import { migrationDatabaseIdentity } from "../migration-database-identity.mjs"
test("migration identity ignores roles and ports, normalizes hostname and decoded database", () => {
  assert.equal(
    migrationDatabaseIdentity("postgresql://runtime:secret@DB.EXAMPLE:6432/lyra%73hield"),
    migrationDatabaseIdentity("postgres://admin:other@db.example:5432/lyrashield?schema=public")
  )
})
test("migration identity rejects different host, database and schema", () => {
  const expected = migrationDatabaseIdentity("postgresql://db.example/lyrashield")
  for (const url of [
    "postgresql://other.example/lyrashield",
    "postgresql://db.example/other",
    "postgresql://db.example/lyrashield?schema=private",
  ])
    assert.notEqual(migrationDatabaseIdentity(url), expected)
  for (const url of [
    undefined,
    "",
    "redis://db.example/lyrashield",
    "postgresql://db.example:9999/lyrashield",
    "postgresql://db.example/",
  ])
    assert.throws(() => migrationDatabaseIdentity(url), /configuration requires/)
})

import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// The Vitest disposable-service guard validates DATABASE_URL before discovering
// runtime suites. A unique schema keeps this DDL away from migrated product rows.
const client = new Client({ connectionString: process.env.DATABASE_URL })
const schema = `index_recovery_${randomUUID().replaceAll("-", "")}`
const sql = readFileSync(
  new URL(
    "../prisma/migrations/20261008120000_p2_16_minute_pack_expiry_index/migration.sql",
    import.meta.url
  ),
  "utf8"
)
  .replace(/--[^\n]*/g, "")
  .trim()

describe("minute-pack concurrent index recovery", () => {
  beforeAll(async () => {
    await client.connect()
    await client.query(`CREATE SCHEMA "${schema}"`)
    await client.query(`SET search_path TO "${schema}"`)
    await client.query(
      'CREATE TABLE "MinutePack" ("expiresAt" timestamptz, "remainingMinutes" numeric, "deletedAt" timestamptz)'
    )
    await client.query(
      "INSERT INTO \"MinutePack\" VALUES ('2026-01-01', 1, NULL), ('2026-01-01', 1, NULL)"
    )
  })

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await client.end()
  })

  it("rejects an existing invalid index instead of reporting a successful migration", async () => {
    // PostgreSQL leaves an invalid index after a failed concurrent build.
    await expect(
      client.query(
        'CREATE UNIQUE INDEX CONCURRENTLY "MinutePack_expiresAt_active_partial_idx" ON "MinutePack" ("expiresAt") WHERE "remainingMinutes" > 0 AND "deletedAt" IS NULL'
      )
    ).rejects.toMatchObject({ code: "23505" })
    const invalid = await client.query(
      "SELECT indisvalid FROM pg_index WHERE indexrelid = '\"MinutePack_expiresAt_active_partial_idx\"'::regclass"
    )
    expect(invalid.rows[0]?.indisvalid).toBe(false)

    await expect(client.query(sql)).rejects.toMatchObject({ code: "42P07" })

    // Recovery is an explicit forward operation on the failed, new index.
    await client.query('DROP INDEX CONCURRENTLY "MinutePack_expiresAt_active_partial_idx"')
    await client.query(sql)
    const recovered = await client.query(
      "SELECT indisvalid, indisunique FROM pg_index WHERE indexrelid = '\"MinutePack_expiresAt_active_partial_idx\"'::regclass"
    )
    expect(recovered.rows).toEqual([{ indisvalid: true, indisunique: false }])
  })
})

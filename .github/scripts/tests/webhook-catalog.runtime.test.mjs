import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"

const require = createRequire(new URL("../../../packages/db/package.json", import.meta.url))
const { PrismaPg } = require("@prisma/adapter-pg")
const { Pool } = require("pg")

test("worker constraint catalog query preserves values through the pinned Prisma adapter", async () => {
  assert.equal(process.env.LYRASHIELD_TEST_DB_DISPOSABLE, "1")
  const target = new URL(process.env.DATABASE_URL ?? "")
  assert.ok(["postgres:", "postgresql:"].includes(target.protocol))
  assert.equal(target.port || "5432", "5432")
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
  assert.equal(target.pathname, "/lyrashield")
  const source = readFileSync(new URL("../verify-webhook-cutover.mjs", import.meta.url), "utf8")
  const match = source.match(/"(SELECT conname AS name,[^\n]+FROM pg_constraint[^\n]+)"/)
  assert.ok(match, "must execute the production probe's actual constraint query")
  const sql = JSON.parse(`"${match[1]}"`)
  const pool = new Pool({ connectionString: target.href, max: 1 })
  const adapter = await new PrismaPg(pool).connect()
  try {
    await pool.query("CREATE TEMP TABLE webhook_catalog_parent (id text PRIMARY KEY)")
    await pool.query(
      'CREATE TEMP TABLE "WebhookEventTrack" (id text PRIMARY KEY, parent text REFERENCES webhook_catalog_parent(id), attempt integer CHECK(attempt >= 0))'
    )
    const {
      rows: [{ schema }],
    } = await pool.query(
      "SELECT nspname AS schema FROM pg_namespace WHERE oid = pg_my_temp_schema()"
    )
    const args = [schema, "WebhookEventTrack"]
    const argTypes = args.map(() => ({ scalarType: "string", arity: "scalar" }))
    const original = sql.replace("contype::text AS type", "contype AS type")
    assert.notEqual(original, sql)
    const native = await pool.query(original, args)
    assert.equal(native.fields.find((field) => field.name === "type").dataTypeID, 18)
    await assert.rejects(
      adapter.queryRaw({ sql: original, args, argTypes }),
      (error) => error.cause?.kind === "UnsupportedNativeDataType" && error.cause?.type === "char"
    )
    const corrected = await adapter.queryRaw({ sql, args, argTypes })
    assert.equal(corrected.rows.length, 3)
    assert.deepEqual(
      corrected.rows,
      native.rows.map((row) => native.fields.map((field) => row[field.name]))
    )
    assert.deepEqual(new Set(native.rows.map((row) => row.type)), new Set(["p", "f", "c"]))
  } finally {
    await adapter.dispose()
    await pool.end()
  }
})

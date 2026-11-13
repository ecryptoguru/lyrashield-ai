import { createHash } from "node:crypto"
import { appendFileSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

const migrations = [
  "20261030103000_scan_admission_capacity",
  "20261030103100_scan_accounting_release",
  "20261030104500_fix_pr_execution_identity",
  "20261030110000_schedule_admission",
]

/** Unknown or mixed states throw; this is never admission or billing authority. */
export async function classifyV26Schema(client, expected) {
  if (
    !Array.isArray(expected) ||
    expected.length !== migrations.length ||
    expected.some(
      (row, index) => row.name !== migrations[index] || !/^[a-f0-9]{64}$/.test(row.checksum ?? "")
    )
  )
    throw new Error("Invalid v26 migration identity")
  let began = false
  let result
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    began = true
    await client.query("SET LOCAL statement_timeout = '10s'")
    await client.query("SET LOCAL row_security = off")
    const role = await client.query(
      "SELECT r.rolsuper OR r.rolbypassrls AS global_read FROM pg_catalog.pg_roles r WHERE r.rolname=current_user"
    )
    if (role.rows?.length !== 1 || role.rows[0].global_read !== true)
      throw new Error("Global database visibility unavailable")
    const state = await client.query(`
      SELECT pg_catalog.to_regclass('public."UserScanSlot"') IS NOT NULL AS slot,
        pg_catalog.to_regclass('public."ScanCapacityReservation"') IS NOT NULL AS capacity,
        EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'public."Scan"'::regclass
          AND a.attname = 'accountingVersion' AND NOT a.attisdropped) AS version,
        EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'public."Scan"'::regclass
          AND a.attname = 'accountingSettledAt' AND NOT a.attisdropped) AS settled`)
    const records = await client.query(
      'SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM public."_prisma_migrations" WHERE migration_name = ANY($1::text[])',
      [migrations]
    )
    if (state.rows?.length !== 1 || !Array.isArray(records.rows))
      throw new Error("Schema state unavailable")
    const flags = [
      state.rows[0].slot,
      state.rows[0].capacity,
      state.rows[0].version,
      state.rows[0].settled,
    ]
    if (flags.some((value) => typeof value !== "boolean")) throw new Error("Schema state malformed")
    if (flags.every((value) => !value) && records.rows.length === 0) result = "legacy"
    else if (
      flags.every(Boolean) &&
      records.rows.length === migrations.length &&
      expected.every((row) => {
        const matches = records.rows.filter((record) => record.migration_name === row.name)
        return (
          matches.length === 1 &&
          matches[0].checksum === row.checksum &&
          matches[0].finished === true &&
          matches[0].rolled_back === false
        )
      })
    )
      result = "current"
    else throw new Error("v26 schema is partial, mismatched or ambiguous")
  } finally {
    if (began) await client.query("ROLLBACK")
  }
  return result
}

async function main() {
  const source = process.env.DATABASE_DIRECT_URL
  if (!source || !process.env.GITHUB_OUTPUT)
    throw new Error("Database or output configuration unavailable")
  const expected = migrations.map((name) => ({
    name,
    checksum: createHash("sha256")
      // Only fixed, source-controlled migration paths are read.
      .update(
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        readFileSync(
          new URL(`../../packages/db/prisma/migrations/${name}/migration.sql`, import.meta.url)
        )
      )
      .digest("hex"),
  }))
  const require = createRequire(new URL("../../packages/db/package.json", import.meta.url))
  const { Client } = require("pg")
  const client = new Client({ connectionString: source, connectionTimeoutMillis: 10_000 })
  try {
    await client.connect()
    const state = await classifyV26Schema(client, expected)
    // GitHub supplies the per-step output file path.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    appendFileSync(process.env.GITHUB_OUTPUT, `v26_schema=${state}\n`)
    console.log(`v26 schema classification: ${state}`)
  } finally {
    await client.end().catch(() => {})
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("v26 schema classification failed; release remains blocked")
    process.exitCode = 1
  })
}

import assert from "node:assert/strict"
import { randomUUID, createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { collectV26PostMigrationReadback } from "../v26-post-migration-readback.mjs"
import {
  observeRuntimeDatabase,
  grantV26RuntimeTables,
  assertNoAdjacentExecutions,
} from "../v26-runtime-database.mjs"
import { classifyV26Schema } from "../v26-schema-classifier.mjs"

const disposableUrl = process.env.V26_ACCOUNTING_DIAGNOSTIC_TEST_POSTGRES_URL
const require = createRequire(new URL("../../../packages/db/package.json", import.meta.url))
const names = [
  "20261030103000_scan_admission_capacity",
  "20261030103100_scan_accounting_release",
  "20261030104500_fix_pr_execution_identity",
  "20261030110000_schedule_admission",
]
const migrationSql = names.map((name) =>
  // Fixed migration names from this checked-out source tree.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  readFileSync(
    new URL(`../../../packages/db/prisma/migrations/${name}/migration.sql`, import.meta.url),
    "utf8"
  )
)
const migrations = names.map((name, index) => ({
  name,
  checksum: createHash("sha256").update(migrationSql[index]).digest("hex"),
}))

test(
  "post-migration readback verifies real forced RLS, grants and migration records",
  { skip: !disposableUrl, timeout: 60_000 },
  async (t) => {
    const url = new URL(disposableUrl)
    assert.equal(process.env.LYRASHIELD_TEST_DB_DISPOSABLE, "1")
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol))
    url.search = ""
    const suffix = randomUUID().replaceAll("-", "")
    const database = `v26_readback_${suffix}`
    const runtime = `v26_rt_${suffix}`
    const quote = (name) => `"${name}"`
    const { Client } = require("pg")
    const admin = new Client({ connectionString: url.toString(), ssl: false })
    let db
    await admin.connect()
    try {
      const role = await admin.query(
        "SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user"
      )
      assert.equal(role.rows[0]?.rolsuper, true)
      await admin.query(`CREATE DATABASE ${quote(database)}`)
      await admin.query(`CREATE ROLE ${quote(runtime)} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
      url.pathname = `/${database}`
      db = new Client({ connectionString: url.toString(), ssl: false })
      await db.connect()
      await db.query(
        `CREATE TABLE public."Scan" (id text, "workspaceId" text, "createdById" text, "sponsorAccountId" text, status text, mode text, "createdAt" timestamp(3))`
      )
      await db.query(
        'CREATE TABLE public."PullRequest" (id text); CREATE TABLE public."Schedule" (id text)'
      )
      await db.query(
        `CREATE TABLE public."_prisma_migrations" (migration_name text, checksum text, finished_at timestamptz, rolled_back_at timestamptz)`
      )
      assert.equal(await classifyV26Schema(db, migrations), "legacy")
      for (const sql of migrationSql) await db.query(sql)
      for (const migration of migrations) {
        await db.query('INSERT INTO public."_prisma_migrations" VALUES ($1,$2,now(),null)', [
          migration.name,
          migration.checksum,
        ])
      }
      assert.equal(await classifyV26Schema(db, migrations), "current")
      const migrationIdentity = await observeRuntimeDatabase(db, { runtime: false })
      await db.query(`SET ROLE ${quote(runtime)}`)
      const observed = await observeRuntimeDatabase(db)
      assert.equal(observed.principal, runtime)
      assert.equal(observed.databaseIdentity, migrationIdentity.databaseIdentity)
      await db.query("RESET ROLE")
      await grantV26RuntimeTables(db, [observed.principal])
      await db.query(
        `CREATE TABLE public."AgentApproval" (status text); CREATE TABLE public.agent_operations (status text); CREATE TABLE public."WebhookEventTrack" (status text)`
      )
      await t.test(
        "adjacent execution observations preserve failed history and reject executing mutations",
        async () => {
          await db.query(
            `INSERT INTO public."AgentApproval" VALUES ('EXECUTION_FAILED'),('PENDING'); INSERT INTO public.agent_operations VALUES ('FAILED'),('APPROVED')`
          )
          await assertNoAdjacentExecutions(db)
          await db.query(`INSERT INTO public.agent_operations VALUES ('EXECUTING')`)
          await assert.rejects(assertNoAdjacentExecutions(db))
          await db.query(`DELETE FROM public.agent_operations WHERE status = 'EXECUTING'`)
          await db.query(`INSERT INTO public."AgentApproval" VALUES ('EXECUTING')`)
          await assert.rejects(assertNoAdjacentExecutions(db))
          await db.query(`DELETE FROM public."AgentApproval" WHERE status = 'EXECUTING'`)
          await assertNoAdjacentExecutions(db)
          assert.equal(
            (
              await db.query(
                `SELECT count(*)::text AS count FROM public."AgentApproval" WHERE status='EXECUTION_FAILED'`
              )
            ).rows[0].count,
            "1"
          )
        }
      )
      const evaluate = () =>
        collectV26PostMigrationReadback(db, { principals: [runtime], migrations })
      await t.test("accepts the exact empty, scoped schema", async () => {
        assert.deepEqual(await evaluate(), {
          status: "NO_DETECTED_DB_BLOCKERS",
          cutoverReady: false,
        })
      })
      await t.test("denies a missing runtime privilege", async () => {
        await db.query(`REVOKE DELETE ON public."UserScanSlot" FROM ${quote(runtime)}`)
        assert.equal((await evaluate()).status, "REVIEW_REQUIRED")
        await db.query(`GRANT DELETE ON public."UserScanSlot" TO ${quote(runtime)}`)
      })
      await t.test("denies bypass roles and seeded legacy holds", async () => {
        await admin.query(`ALTER ROLE ${quote(runtime)} BYPASSRLS`)
        assert.equal((await evaluate()).status, "REVIEW_REQUIRED")
        await admin.query(`ALTER ROLE ${quote(runtime)} NOBYPASSRLS`)
        await db.query(
          `INSERT INTO public."UserScanSlot" ("userId","scanId","workspaceId") VALUES ('test','test','test')`
        )
        assert.equal((await evaluate()).status, "REVIEW_REQUIRED")
      })
    } finally {
      await db?.end().catch(() => {})
      await admin.query(`DROP DATABASE IF EXISTS ${quote(database)} WITH (FORCE)`).catch(() => {})
      await admin.query(`DROP ROLE IF EXISTS ${quote(runtime)}`).catch(() => {})
      await admin.end()
    }
  }
)

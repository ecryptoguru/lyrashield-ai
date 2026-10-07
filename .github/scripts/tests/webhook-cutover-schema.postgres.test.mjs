import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import test from "node:test"
import * as contract from "../../../ops/worker/webhook-cutover-schema.mjs"

const disposableUrl = process.env.WEBHOOK_RECOVERY_SCHEMA_POSTGRES_URL
const require = createRequire(new URL("../../../packages/db/package.json", import.meta.url))

test(
  "held recovery verifies actual PostgreSQL catalogs without rerunning migrations",
  {
    skip: !disposableUrl,
    timeout: 30_000,
  },
  async (t) => {
    const url = new URL(disposableUrl)
    assert.ok(
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
      "disposable PostgreSQL must be loopback"
    )
    assert.equal(url.search, "", "disposable URL must not override its host")
    const { Client } = process.env.WEBHOOK_RECOVERY_PG_MODULE
      ? require(process.env.WEBHOOK_RECOVERY_PG_MODULE)
      : require("pg")
    const client = new Client({ connectionString: disposableUrl, ssl: false })
    const schema = `recovery_${randomUUID().replaceAll("-", "")}`
    const role = `${schema}_Runtime`
    const quote = (value) => `"${value.replaceAll('"', '""')}"`
    const queries = []
    const prisma = {
      async $queryRawUnsafe(sql, ...values) {
        assert.match(sql, /^\s*SELECT\b/i, "recovery schema verifier must only read")
        queries.push(sql)
        return (await client.query(sql, values)).rows
      },
    }
    await client.connect()
    try {
      await client.query(`CREATE SCHEMA ${quote(schema)}`)
      await client.query(`SET search_path TO ${quote(schema)}`)
      await client.query('CREATE TABLE "WebhookEvent" (id TEXT PRIMARY KEY)')
      await client.query(
        "CREATE TABLE _prisma_migrations (migration_name TEXT, checksum TEXT, finished_at TIMESTAMPTZ, rolled_back_at TIMESTAMPTZ)"
      )
      for (const name of contract.WEBHOOK_CUTOVER_MIGRATION_NAMES) {
        const sql = await readFile(
          new URL(`../../../packages/db/prisma/migrations/${name}/migration.sql`, import.meta.url),
          "utf8"
        )
        const checksum = createHash("sha256").update(sql).digest("hex")
        assert.equal(
          checksum,
          contract.WEBHOOK_CUTOVER_MIGRATION_CHECKSUMS[name],
          "contract must bind actual migration bytes"
        )
        await client.query(sql)
        await client.query(
          "INSERT INTO _prisma_migrations VALUES ($1, $2, CURRENT_TIMESTAMP, NULL)",
          [name, checksum]
        )
      }
      await t.test("accepts the fully migrated catalog and only executes SELECT", async () => {
        assert.equal(
          await contract.assertFullyMigratedWebhookSchema(prisma, "durable-claims/2"),
          true
        )
        assert.ok(queries.length >= 5)
      })
      const rejectMutation = async (name, mutation, expected) =>
        t.test(name, async () => {
          await client.query("BEGIN")
          try {
            await client.query(mutation)
            await assert.rejects(
              contract.assertFullyMigratedWebhookSchema(prisma, "durable-claims/2"),
              expected
            )
          } finally {
            await client.query("ROLLBACK")
          }
        })
      await rejectMutation(
        "rejects a changed migration checksum",
        "UPDATE _prisma_migrations SET checksum = repeat('0', 64)",
        /migration checksums/
      )
      await rejectMutation(
        "rejects a migration without completion",
        "UPDATE _prisma_migrations SET finished_at = NULL",
        /migration checksums/
      )
      await rejectMutation(
        "rejects a partial UTC schema",
        'ALTER TABLE "WebhookEventTrack" DROP COLUMN "leaseExpiresAtUtc"',
        /columns/
      )
      await rejectMutation(
        "rejects a nullable updatedAt column",
        'ALTER TABLE "WebhookEventTrack" ALTER COLUMN "updatedAt" DROP NOT NULL',
        /columns/
      )
      await rejectMutation(
        "rejects altered due-index ordering",
        'DROP INDEX "WebhookEventTrack_status_nextAttemptAtUtc_idx"; CREATE INDEX "WebhookEventTrack_status_nextAttemptAtUtc_idx" ON "WebhookEventTrack" (status, "nextAttemptAtUtc" DESC)',
        /index WebhookEventTrack_status_nextAttemptAtUtc_idx/
      )
      await t.test("rejects incompatible worker protocol", async () => {
        await assert.rejects(
          contract.assertFullyMigratedWebhookSchema(prisma, "durable-claims/1"),
          /protocol/
        )
      })
      await t.test("actual runtime role flags must preserve RLS", async () => {
        assert.equal(typeof contract.assertRuntimeRoleLeastPrivilege, "function")
        await client.query(`CREATE ROLE ${quote(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
        const workerUrl = `postgresql://${role}.abcdefghijklmnopqrst:fixture@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=verify-full`
        await client.query(`SET ROLE ${quote(role)}`)
        assert.equal(await contract.assertRuntimeRoleLeastPrivilege(prisma, workerUrl), true)
        await assert.rejects(
          contract.assertRuntimeRoleLeastPrivilege(
            prisma,
            workerUrl.replace(`${role}.`, "wrong_role.")
          ),
          /runtime principal privileges/
        )
        await client.query("RESET ROLE")
        for (const flag of ["BYPASSRLS", "SUPERUSER"]) {
          await client.query(`ALTER ROLE ${quote(role)} ${flag}`)
          await client.query(`SET ROLE ${quote(role)}`)
          try {
            await assert.rejects(
              contract.assertRuntimeRoleLeastPrivilege(prisma, workerUrl),
              /runtime principal privileges/
            )
          } finally {
            await client.query("RESET ROLE")
          }
          await client.query(`ALTER ROLE ${quote(role)} NO${flag}`)
        }
      })
    } finally {
      await client.query("RESET ROLE").catch(() => {})
      await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => {})
      await client.query(`DROP ROLE IF EXISTS ${quote(role)}`).catch(() => {})
      await client.end()
    }
  }
)

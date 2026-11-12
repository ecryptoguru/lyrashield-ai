import { createHash, randomBytes } from "node:crypto"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({ transaction: vi.fn() }))
vi.mock("./client", () => ({ prisma: { $transaction: fixture.transaction } }))
vi.mock("./system-client", () => ({ getSystemPrisma: vi.fn() }))
vi.mock("./scoping", () => ({
  runWithDatabaseRLSContext: (_workspaceId: string, fn: () => unknown) => fn(),
}))
vi.mock("@lyrashield/config", () => ({ env: {}, isProd: false, isTest: true }))

import {
  readActiveSharedReport,
  sharedReportSnapshotBinding,
  sharedReportStillActive,
} from "./report-service"
import type { ScopedTransaction } from "./rls"

const enabled = process.env.SHARE_RECHECK_POSTGRES_TEST === "1"
const url = process.env.DATABASE_URL
const suffix = randomBytes(6).toString("hex")
const schema = `share_recheck_${suffix}`
const role = `share_runtime_${suffix}`
const token = "a".repeat(64)
const tokenHash = createHash("sha256").update(token).digest("hex")
const first = new Client({ connectionString: url })
const second = new Client({ connectionString: url })

function adapter(client: Client) {
  const raw = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.reduce(
      (text, part, i) => text + part + (i < values.length ? `$${i + 1}` : ""),
      ""
    )
    return (await client.query(sql, values)).rows
  }
  return { $queryRaw: raw, $executeRaw: raw } as unknown as ScopedTransaction
}

describe.skipIf(!enabled)("shared report revocation under real PostgreSQL RLS", () => {
  beforeAll(async () => {
    if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1" || !url)
      throw new Error("Requires explicit disposable database opt-in")
    const parsed = new URL(url!)
    if (
      !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname) ||
      !/(?:^|[_-])(?:test|ci|disposable)(?:$|[_-])/i.test(parsed.pathname.slice(1)) ||
      !parsed.username ||
      !parsed.password ||
      parsed.search ||
      Object.keys(process.env).some(
        (key) =>
          /^PG(?:HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|PASSFILE|SERVICE|SERVICEFILE|SYSCONFDIR|OPTIONS)$/.test(
            key
          ) && process.env[key]
      )
    )
      throw new Error("Requires a named loopback disposable database and explicit credentials")
    await first.connect()
    await second.connect()
    await first.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`)
    await first.query(`CREATE SCHEMA "${schema}"`)
    await first.query(`CREATE TABLE "${schema}"."Report" (
      "id" text, "workspaceId" text, "shareTokenHash" text, "revokedAt" timestamp,
      "deletedAt" timestamp, "shareExpiresAt" timestamp, "type" text, "scanId" text,
      "contentJson" jsonb, "provenanceJson" jsonb)`)
    await first.query(`ALTER TABLE "${schema}"."Report" ENABLE ROW LEVEL SECURITY`)
    await first.query(`ALTER TABLE "${schema}"."Report" FORCE ROW LEVEL SECURITY`)
    await first.query(
      `CREATE POLICY workspace ON "${schema}"."Report" USING ("workspaceId" = current_setting('app.current_workspace_id', true)) WITH CHECK ("workspaceId" = current_setting('app.current_workspace_id', true))`
    )
    await first.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`)
    await first.query(`GRANT SELECT, UPDATE ON "${schema}"."Report" TO "${role}"`)
    await first.query(
      `INSERT INTO "${schema}"."Report" VALUES ($1,$2,$3,NULL,NULL,now() + interval '1 hour','launch_readiness',NULL,$4,$5)`,
      ["report", "ws", tokenHash, '{"public":"value"}', '{"private":"value"}']
    )
    for (const client of [first, second]) {
      await client.query(`SET search_path TO "${schema}"`)
      await client.query(`SET ROLE "${role}"`)
      await client.query(`SELECT set_config('app.current_workspace_id', 'ws', false)`)
    }
    fixture.transaction.mockImplementation(async (callback, options) => {
      expect(options?.isolationLevel).toBe("ReadCommitted")
      await second.query("BEGIN ISOLATION LEVEL READ COMMITTED")
      try {
        const result = await callback(adapter(second))
        await second.query("COMMIT")
        return result
      } catch (error) {
        await second.query("ROLLBACK")
        throw error
      }
    })
  })
  afterAll(async () => {
    await first.query("ROLLBACK").catch(() => {})
    await first.query("RESET ROLE").catch(() => {})
    await second.query("RESET ROLE").catch(() => {})
    await first.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    await first.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {})
    await first.end()
    await second.end()
  })

  it("rejects revocation committed after the repeatable-read snapshot but before release", async () => {
    await first.query("BEGIN ISOLATION LEVEL REPEATABLE READ")
    await first.query("SELECT set_config('app.current_workspace_id', 'ws', true)")
    await second.query('UPDATE "Report" SET "revokedAt" = now() WHERE "id" = $1', ["report"])
    const old = await readActiveSharedReport(adapter(first), "ws", "report", token)
    expect(old).not.toBeNull()
    const binding = sharedReportSnapshotBinding(old!)
    expect(await sharedReportStillActive("ws", "report", token, binding)).toBe(false)
    await first.query("COMMIT")
  })

  it("rejects token rotation, changed private binding and foreign workspace", async () => {
    await second.query('UPDATE "Report" SET "revokedAt" = NULL WHERE "id" = $1', ["report"])
    const original = await readActiveSharedReport(adapter(second), "ws", "report", token)
    const binding = sharedReportSnapshotBinding(original!)
    expect(await sharedReportStillActive("ws", "report", token, binding)).toBe(true)
    expect(await sharedReportStillActive("foreign", "report", token, binding)).toBe(false)
    await second.query('UPDATE "Report" SET "provenanceJson" = $1 WHERE "id" = $2', [
      '{"private":"changed"}',
      "report",
    ])
    expect(await sharedReportStillActive("ws", "report", token, binding)).toBe(false)
    await second.query('UPDATE "Report" SET "shareTokenHash" = $1 WHERE "id" = $2', [
      "b".repeat(64),
      "report",
    ])
    expect(await sharedReportStillActive("ws", "report", token, binding)).toBe(false)
  })
})

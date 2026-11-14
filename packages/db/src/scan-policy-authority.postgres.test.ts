import { createHash, randomUUID } from "node:crypto"
import pg from "pg"
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest"
import { createScanDispatchAuthorityBroker } from "./scan-dispatch-authority-broker"
import {
  applyPreparationFixtureMigration,
  installPreparationFixtureRole,
  preparationFixture,
  preparationInput,
} from "../scripts/tests/scan-preparation-fixture"
import { queueFixtureWorker } from "../scripts/tests/queue-outbox-fixture"

// Hoisting runs this guard before imports can construct a client from ambient
// env. Bind the fixture's privileged DATABASE_URL role to its restricted broker
// role through the shared disposable-pair guard.
await vi.hoisted(async () => {
  const runtime = process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL
  if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1" || !runtime) return
  const { assertDisposableDatabasePair } =
    await import("../../../.github/scripts/vitest-database-env.mjs")
  assertDisposableDatabasePair({ ...process.env, RLS_RUNTIME_DATABASE_URL: runtime })
})

const enabled =
  process.env.SCAN_DISPATCH_AUTHORITY_POSTGRES_TEST === "1" &&
  process.env.LYRASHIELD_TEST_DB_DISPOSABLE === "1"
let owner: pg.Pool
let broker: ReturnType<typeof createScanDispatchAuthorityBroker>
const queueWorker = queueFixtureWorker()

async function policy() {
  const workspaceId = `policy-workspace-${randomUUID()}`
  const id = `policy-${randomUUID()}`
  await owner.query(
    'INSERT INTO "Workspace"(id,name,slug,"createdAt","updatedAt") VALUES($1,$1,$1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
    [workspaceId]
  )
  await owner.query(
    'INSERT INTO "Policy"(id,"workspaceId",name,"blockedPaths","allowedDomains","updatedAt") VALUES($1,$2,$1,\'{}\',\'{}\',\'2026-01-01\')',
    [id, workspaceId]
  )
  return id
}
async function digest(id: string | null) {
  return (await owner.query("SELECT app.scan_policy_digest($1) digest", [id])).rows[0]
    .digest as string
}

describe.skipIf(!enabled)("database-owned policy authority generations", () => {
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await queueWorker.open()
    await applyPreparationFixtureMigration(owner)
    await installPreparationFixtureRole(owner)
    broker = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      preparationAuthority: "checked-intent-v1",
    })
  }, 30000)
  afterAll(async () => {
    await broker?.close()
    await owner?.end()
    await queueWorker.close()
  })

  it.each([
    "\"blockedPaths\"=ARRAY['/private']",
    "\"allowedDomains\"=ARRAY['example.test']",
    '"scanWindow"=\'{"start":"01:00"}\'::jsonb',
    '"rateLimit"=\'{"requestsPerSecond":1}\'::jsonb',
    '"destructiveTestsAllowed"=true',
    '"approvalRequired"=true',
    "\"networkEgressPolicy\"='none'",
    '"maxBudgetUsd"=0',
    '"maxDurationMinutes"=1',
    '"piiRedactionEnabled"=false',
    '"evidenceRetentionDays"=1',
    '"deletedAt"=CURRENT_TIMESTAMP',
  ])("binds complete policy changes even with unchanged updatedAt: %s", async (assignment) => {
    const id = await policy(),
      before = await digest(id)
    await owner.query(`UPDATE "Policy" SET ${assignment} WHERE id=$1`, [id])
    expect(await digest(id)).not.toBe(before)
    expect(
      (await owner.query('SELECT "authorityRevision" FROM "Policy" WHERE id=$1', [id])).rows[0]
        .authorityRevision
    ).toBe(2)
  })

  it("does not revive an admitted policy after A→B→A with restored timestamps", async () => {
    const id = await policy(),
      before = await digest(id)
    await owner.query('UPDATE "Policy" SET "approvalRequired"=true WHERE id=$1', [id])
    await owner.query(
      'UPDATE "Policy" SET "approvalRequired"=false,"updatedAt"=\'2026-01-01\' WHERE id=$1',
      [id]
    )
    expect(await digest(id)).not.toBe(before)
    expect(
      (await owner.query('SELECT "authorityRevision" FROM "Policy" WHERE id=$1', [id])).rows[0]
        .authorityRevision
    ).toBe(3)
  })

  it("assigns a new incarnation on delete/reinsert even when supplied the old authority", async () => {
    const id = await policy(),
      before = await digest(id)
    const row = (await owner.query('SELECT * FROM "Policy" WHERE id=$1', [id])).rows[0]
    await owner.query('DELETE FROM "Policy" WHERE id=$1', [id])
    await owner.query(
      'INSERT INTO "Policy"(id,"workspaceId",name,"blockedPaths","allowedDomains","updatedAt","authorityIncarnation","authorityRevision") VALUES($1,$2,$1,\'{}\',\'{}\',\'2026-01-01\',$3,$4)',
      [id, row.workspaceId, row.authorityIncarnation, row.authorityRevision]
    )
    expect(await digest(id)).not.toBe(before)
  })

  it("rejects caller-written generations and preserves timestamps-only updates", async () => {
    const id = await policy(),
      before = await digest(id)
    await owner.query('UPDATE "Policy" SET "updatedAt"=CURRENT_TIMESTAMP WHERE id=$1', [id])
    expect(await digest(id)).toBe(before)
    await expect(
      owner.query('UPDATE "Policy" SET "authorityRevision"=1+"authorityRevision" WHERE id=$1', [id])
    ).rejects.toMatchObject({ code: "23514" })
    await expect(
      owner.query('UPDATE "Policy" SET "authorityIncarnation"=\'forged\' WHERE id=$1', [id])
    ).rejects.toMatchObject({ code: "23514" })
  })

  it("does not revive null policy admission after null→policy→null", async () => {
    const f = await preparationFixture(owner)
    const id = `policy-${randomUUID()}`
    await owner.query(
      'INSERT INTO "Policy"(id,"workspaceId",name,"blockedPaths","allowedDomains","updatedAt") VALUES($1,$2,$1,\'{}\',\'{}\',CURRENT_TIMESTAMP)',
      [id, f.workspaceId]
    )
    const before = (
      await owner.query("SELECT app.scan_dispatch_scope_digest($1) digest", [f.scanId])
    ).rows[0].digest
    await owner.query('UPDATE "Scan" SET "policyId"=$2 WHERE id=$1', [f.scanId, id])
    await owner.query('UPDATE "Scan" SET "policyId"=NULL WHERE id=$1', [f.scanId])
    expect(
      (
        await owner.query(
          'SELECT app.scan_dispatch_scope_digest($1) digest,"policyBindingRevision" FROM "Scan" WHERE id=$1',
          [f.scanId]
        )
      ).rows[0]
    ).toMatchObject({ policyBindingRevision: 3 })
    expect(
      (await owner.query("SELECT app.scan_dispatch_scope_digest($1) digest", [f.scanId])).rows[0]
        .digest
    ).not.toBe(before)
    await expect(broker.prepare(preparationInput(f))).rejects.toMatchObject({
      code: "DISPATCH_SCOPE_CHANGED",
    })
    await expect(
      owner.query('UPDATE "Scan" SET "policyBindingRevision"=1 WHERE id=$1', [f.scanId])
    ).rejects.toMatchObject({ code: "23514" })
    expect(
      (
        await owner.query(
          'SELECT count(*)::int n FROM "ScanDispatchStart" WHERE "operationId"=$1',
          [f.operationId]
        )
      ).rows[0].n
    ).toBe(0)
  })

  it("distinguishes absent, missing and pre-v2 policy bindings", async () => {
    const none = await digest(null)
    expect(none).not.toBe(await digest("missing-policy"))
    expect(none).not.toBe(
      createHash("sha256").update('{"schemaVersion": "scan-policy/none"}').digest("hex")
    )
  })
})

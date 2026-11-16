import { randomUUID } from "node:crypto"
import pg from "pg"
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest"
import { bindScanPreparationContext } from "./scan-preparation-authority"
import {
  preparationFixture,
  installPreparationFixtureRole,
  installPreparationRevokerRole,
  insertPreparationAttempt,
  sealPreparationBundle,
} from "../scripts/tests/scan-preparation-fixture"
import { queueFixtureWorker } from "../scripts/tests/queue-outbox-fixture"

// Hoisting runs this guard before imports can construct a client from ambient
// env. This runner's independent clone has no RLS_RUNTIME_DATABASE_URL, so bind
// the privileged DATABASE_URL role to its restricted preparation broker role.
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
const queueWorker = queueFixtureWorker()
let owner: pg.Pool, runtime: pg.Pool, revoker: pg.Pool
async function fixture() {
  // Only the runner's independent clone is allowed to close epochs.
  expect((await owner.query("SELECT current_database() name")).rows[0].name).toBe(
    "lyrashield_epoch_test"
  )
  await owner.query(
    'UPDATE "ScanAuthorityEpoch" SET "isOpen"=false,"openKey"=NULL,"closedAt"=CURRENT_TIMESTAMP WHERE "isOpen"'
  )
  const epochId = `authority-race-epoch-${randomUUID()}`
  await owner.query(
    'INSERT INTO "ScanAuthorityEpoch"(id,epoch,"isOpen","openKey","openedAt","createdAt","updatedAt") VALUES($1,(SELECT max(epoch)+1 FROM "ScanAuthorityEpoch"),true,\'open\',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
    [epochId]
  )
  const f = await preparationFixture(owner, 1, "authority-race", undefined, false, "RESERVED", {
    epochId,
  })
  return f
}
const close =
  'UPDATE "ScanAuthorityEpoch" SET "isOpen"=false,"openKey"=NULL,"closedAt"=CURRENT_TIMESTAMP WHERE id=$1'
async function waitsForGate() {
  for (let i = 0; i < 100; i++) {
    if (
      (
        await owner.query(
          "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=1819234670 AND objid=1 AND mode='ShareLock' AND NOT granted"
        )
      ).rowCount
    )
      return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error("Epoch writer did not wait at the shared gate")
}

describe.skipIf(!enabled)("isolated epoch closure preparation fence", () => {
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
    runtime = new pg.Pool({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL,
      max: 2,
    })
    revoker = new pg.Pool({
      connectionString: process.env.DISPATCH_AUTHORITY_REVOKER_DATABASE_URL,
      max: 2,
    })
    await installPreparationRevokerRole(owner)
    await queueWorker.open()
  })
  afterAll(async () => {
    await queueWorker.close()
    await owner?.end()
    await runtime?.end()
    await revoker?.end()
  })
  it("revokes temporary access on the current cloned database even when the broker role exists", async () => {
    expect((await owner.query("SELECT current_database() name")).rows[0].name).toBe(
      "lyrashield_epoch_test"
    )
    await owner.query(
      "DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC',current_database()); END $$"
    )
    try {
      await installPreparationFixtureRole(owner)
      const result = await owner.query<{ allowed: boolean }>(
        "SELECT has_database_privilege('dispatch_prepare_broker',current_database(),'TEMPORARY') AS allowed"
      )
      expect(result.rows[0]?.allowed).toBe(false)
    } finally {
      await owner.query(
        "DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC',current_database()); END $$"
      )
    }
  })
  it("sees a committed writer-first closure and rejects raw checked insertion", async () => {
    const f = await fixture(),
      c = await runtime.connect(),
      w = await revoker.connect()
    try {
      await c.query("BEGIN")
      await bindScanPreparationContext(c, f.operationId)
      await w.query("BEGIN")
      await w.query(close, [f.epochId])
      expect(
        (await c.query("SELECT app.acquire_scan_preparation_gate() acquired")).rows[0].acquired
      ).toBe(false)
      await w.query("COMMIT")
      await c.query("SELECT app.acquire_scan_preparation_gate()")
      await expect(insertPreparationAttempt(c, f)).rejects.toThrow("open authority epoch")
    } finally {
      await c.query("ROLLBACK")
      await w.query("ROLLBACK")
      c.release()
      w.release()
    }
    expect(
      (
        await owner.query(
          'SELECT count(*)::int n FROM "ScanDispatchAttempt" WHERE "operationId"=$1',
          [f.operationId]
        )
      ).rows[0].n
    ).toBe(0)
  })
  it("holds preparation-first closure before row DML until the sealed bundle commits", async () => {
    const f = await fixture(),
      c = await runtime.connect(),
      w = await revoker.connect()
    try {
      await c.query("BEGIN")
      await bindScanPreparationContext(c, f.operationId)
      await c.query("SELECT app.acquire_scan_preparation_gate()")
      const attemptId = await insertPreparationAttempt(c, f)
      await w.query("BEGIN")
      const closure = w.query(close, [f.epochId])
      await waitsForGate()
      await sealPreparationBundle(c, f, attemptId)
      await c.query("COMMIT")
      await closure
      await w.query("COMMIT")
      expect(
        (await owner.query('SELECT "isOpen" FROM "ScanAuthorityEpoch" WHERE id=$1', [f.epochId]))
          .rows[0].isOpen
      ).toBe(false)
      expect(
        (
          await owner.query('SELECT state FROM "ScanDispatchOperation" WHERE "operationId"=$1', [
            f.operationId,
          ])
        ).rows[0].state
      ).toBe("PREPARING")
    } finally {
      await c.query("ROLLBACK")
      await w.query("ROLLBACK")
      c.release()
      w.release()
    }
  })
})

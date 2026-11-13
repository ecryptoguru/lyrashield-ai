import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import test from "node:test"
import { assertPairedWorkDrained } from "../paired-runtime-hold.mjs"

const url = process.env.PAIRED_DRAIN_TEST_POSTGRES_URL
// Copied DB uses all product migrations. Each case exercises the actual
// production SQL and actual PostgreSQL RLS in the same read-only transaction.
test(
  "paired drain recognizes retained final reservations and rejects unresolved global work",
  { skip: !url, timeout: 60_000 },
  async (t) => {
    const template = new URL(url)
    assert.equal(process.env.LYRASHIELD_TEST_DB_DISPOSABLE, "1")
    assert.equal(template.hostname, "127.0.0.1")
    assert.equal(template.pathname, "/paired_drain_fixture_template")
    const { Client } = createRequire(new URL("../../../packages/db/package.json", import.meta.url))(
      "pg"
    )
    const settings = { connectionTimeoutMillis: 5000, statement_timeout: 5000 }
    const admin = new Client({ ...settings, connectionString: template.href })
    const suffix = randomUUID().replaceAll("-", "")
    const database = "paired_drain_" + suffix,
      role = "drain_read_" + suffix
    let db
    await admin.connect()
    try {
      await admin.query(`CREATE DATABASE ${database} TEMPLATE paired_drain_fixture_template`)
      await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
      template.pathname = "/" + database
      db = new Client({ ...settings, connectionString: template.href })
      await db.connect()
      const read = () =>
        assertPairedWorkDrained(
          { llen: async () => 0, zcard: async () => 0 },
          db,
          async () => "V26_EXECUTION_DRAIN_VERIFIED"
        )
      const busy = () => assert.rejects(read(), /unresolved execution or financial ownership/)
      await read()
      await db.query(
        `INSERT INTO "ScanCapacityReservation" ("scanId","accountId","workspaceId","userId",multiplier,state,"updatedAt","stoppedAt") VALUES ('retained','account','ws','user',1,'RELEASED',now(),now())`
      )
      await read() // stopped, nonbillable, parent already deleted
      for (const state of ["WAITING", "RESERVED", "RUNNING", "REVIEW_REQUIRED"]) {
        await db.query(
          'UPDATE "ScanCapacityReservation" SET state=$1 WHERE "scanId"=\'retained\'',
          [state]
        )
        await busy()
      }
      await assert.rejects(db.query(`UPDATE "ScanCapacityReservation" SET state='UNRECOGNIZED'`), {
        code: "23514",
      })
      for (const state of ["RELEASED", "SETTLED"]) {
        await db.query('UPDATE "ScanCapacityReservation" SET state=$1,"stoppedAt"=NULL', [state])
        await busy()
        await db.query('UPDATE "ScanCapacityReservation" SET "stoppedAt"=now()')
        await read()
      }
      await db.query(`INSERT INTO "Workspace" (id,name,slug,"updatedAt") VALUES ('ws','fixture','fixture',now());
      INSERT INTO "Scan" (id,"workspaceId",goal,"createdById",status,"accountingVersion","updatedAt") VALUES ('retained','ws','TEST_APP','user','FAILED',2,now())`)
      await busy() // terminal v2 scan still awaits slot release
      await db.query(`UPDATE "Scan" SET "accountingSettledAt"=now()`)
      await read()
      await db.query(`UPDATE "Scan" SET status='RUNNING'`)
      await busy()
      await db.query(`UPDATE "Scan" SET status='COMPLETED'`)
      await read()
      await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`)
      await db.query(`SET ROLE ${role}`)
      await assert.rejects(read(), { code: "42501" })
      await db.query("RESET ROLE")
      await db.query(`UPDATE "ScanCapacityReservation" SET state='RELEASED'`)
      await read()
      t.diagnostic(
        "Retained stopped RELEASED/SETTLED and acknowledged surviving v2 accepted. Four open reservation states, absent stop/slot acknowledgement and active Scan rejected. Unknown state rejected by schema and filtered read refused by PostgreSQL."
      )
    } finally {
      try {
        await db?.end()
        await admin.query(`DROP DATABASE IF EXISTS ${database}`)
        await admin.query(`DROP ROLE IF EXISTS ${role}`)
      } finally {
        await admin.end()
      }
    }
  }
)

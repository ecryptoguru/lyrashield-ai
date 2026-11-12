// Executed only from the exact candidate image against disposable Postgres.
import assert from "node:assert/strict"
import { existsSync, writeFileSync } from "node:fs"
import { setTimeout } from "node:timers/promises"
import {
  readColdDatabaseEpochHash,
  assertColdDatabaseEpoch,
  configureColdDatabaseEpochFailureHandler,
} from "./src/cold-database-epoch.ts"
import { prisma } from "@lyrashield/db"

let failures = 0
configureColdDatabaseEpochFailureHandler(() => {
  failures += 1
})
try {
  const before = await readColdDatabaseEpochHash()
  assert.equal(before, process.env.LYRASHIELD_COLD_DATABASE_EPOCH_SHA256)
  await assertColdDatabaseEpoch()
  writeFileSync("/tmp/cold-epoch-await-restart", "ready", { mode: 0o600, flag: "wx" })
  const deadline = Date.now() + 90000
  while (!existsSync("/tmp/cold-epoch-restarted")) {
    assert.ok(Date.now() < deadline, "Disposable Postgres restart acknowledgment unavailable")
    await setTimeout(100)
  }
  const after = await readColdDatabaseEpochHash()
  assert.notEqual(after, before)
  await assert.rejects(assertColdDatabaseEpoch())
  await assert.rejects(assertColdDatabaseEpoch())
  assert.ok(failures >= 1)
  console.log(
    JSON.stringify({
      schema: "lyrashield-cold-database-epoch-image/1",
      before,
      after,
      workerImage: process.env.COLD_PROBE_WORKER_IMAGE,
      productRevision: process.env.COLD_PROBE_PRODUCT_REVISION,
      beforeMatched: true,
      restartChangedEpoch: true,
      mismatchRejected: true,
      repeatedMismatchRejected: true,
      paidExecutionInvoked: false,
      exitCode: 0,
    })
  )
} finally {
  await prisma.$disconnect()
}

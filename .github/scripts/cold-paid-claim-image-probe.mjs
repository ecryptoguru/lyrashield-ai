// Real image BullMQ crash/redelivery at the actual funded admission boundary.
// The initial callback calls the real admission API and parks before execution.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"

assert.equal(process.env.NODE_ENV, "test")
assert.equal(process.env.LYRASHIELD_TEST_DB_DISPOSABLE, "1")
assert.equal(
  process.env.DATABASE_URL,
  "postgresql://app_runtime_ci:runtime-ci-only@postgres:5432/lyrashield?schema=public"
)
assert.equal(
  process.env.DATABASE_SYSTEM_URL,
  "postgresql://lyrashield:lyrashield@postgres:5432/lyrashield?schema=public"
)
assert.equal(process.env.DATABASE_DIRECT_URL, process.env.DATABASE_SYSTEM_URL)
assert.equal(process.env.REDIS_URL, "redis://redis:6379")
assert.match(process.env.COLD_PROBE_PRODUCT_REVISION, /^[a-f0-9]{40}$/)
assert.match(process.env.COLD_PROBE_WORKER_DIGEST, /^sha256:[a-f0-9]{64}$/)
for (const key of [
  "OPENAI_API_KEY",
  "AZURE_AI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
])
  assert.ok(!process.env[key], "real provider credentials forbidden")

const trap = createServer((_request, response) => {
  writeFileSync("/proof/provider-called", "unexpected")
  response.writeHead(503).end()
})
await new Promise((resolve, reject) => trap.once("error", reject).listen(0, "127.0.0.1", resolve))
const provider = "http://127.0.0.1:" + trap.address().port
process.env.OPENAI_BASE_URL = provider
process.env.AZURE_AI_BASE_URL = provider
process.env.LYRASHIELD_ENGINE_PATH = "/proof/engine-trap"

const db = await import("@lyrashield/db")
const { PrismaClient } = await import("@lyrashield/db/src/generated/prisma")
const { createBoundedPgAdapter } = await import("@lyrashield/db/src/pool")
const owner = new PrismaClient({ adapter: createBoundedPgAdapter(process.env.DATABASE_DIRECT_URL) })
const integrations = await import("@lyrashield/integrations")
const { Worker } = await import("bullmq")
const { SCAN_QUEUE_NAME } = await import("@lyrashield/types")
const { claimEngineCapacity } = await import("./src/jobs/run-scan/capacity-lifecycle.ts")
const { processScanJob } = await import("./src/jobs/run-scan.job.ts")
const queue = integrations.getScanQueue()
const identityFile = "/proof/identity.json"

async function snapshot(identity) {
  const scan = await owner.scan.findUniqueOrThrow({ where: { id: identity.scanId } })
  const claim = await owner.scanEvent.findMany({
    where: { scanId: identity.scanId, stage: "billable_boundary" },
    orderBy: { id: "asc" },
  })
  const reservation = await owner.scanCapacityReservation.findUniqueOrThrow({
    where: { scanId: identity.scanId },
  })
  const slot = await owner.userScanSlot.findUniqueOrThrow({ where: { userId: identity.userId } })
  return JSON.parse(JSON.stringify({ scan, claim, reservation, slot }))
}

const phase = process.argv[2]
let worker
try {
  if (phase === "init") {
    assert.ok(!existsSync(identityFile))
    const nonce = randomUUID()
    const identity = {
      userId: "cold-user-" + nonce,
      workspaceId: "cold-ws-" + nonce,
      targetId: "cold-target-" + nonce,
      scanId: "cold-scan-" + nonce,
      nonce,
    }
    const now = new Date()
    await owner.user.create({
      data: {
        id: identity.userId,
        name: "Disposable cold fixture",
        email: nonce + "@example.invalid",
      },
    })
    await owner.workspace.create({
      data: {
        id: identity.workspaceId,
        name: "Disposable cold fixture",
        slug: identity.workspaceId,
      },
    })
    await owner.target.create({
      data: {
        id: identity.targetId,
        workspaceId: identity.workspaceId,
        name: "Provider never executed",
        type: "REPO",
        repoFullName: "fixture/private",
        branch: "fixture",
      },
    })
    await owner.billingAccount.create({
      data: {
        accountId: identity.userId,
        workspaceId: identity.workspaceId,
        provider: "test",
        externalId: identity.userId,
        status: "active",
        currentPlan: "PRO",
        interval: "monthly",
        currentPeriodStart: now,
        graceCycleStart: now,
      },
    })
    await owner.usageRecord.create({
      data: {
        accountId: identity.userId,
        workspaceId: identity.workspaceId,
        kind: "pool_grant",
        quantity: 10,
        cycleStart: now,
        idempotencyKey: identity.userId + ":grant",
      },
    })
    await owner.scan.create({
      data: {
        id: identity.scanId,
        workspaceId: identity.workspaceId,
        targetId: identity.targetId,
        createdById: identity.userId,
        goal: "TEST_APP",
        mode: "STANDARD",
        status: "RUNNING",
        startedAt: now,
        accountingVersion: 2,
      },
    })
    await owner.scanCapacityReservation.create({
      data: {
        scanId: identity.scanId,
        accountId: identity.userId,
        userId: identity.userId,
        workspaceId: identity.workspaceId,
        multiplier: 1,
      },
    })
    await owner.userScanSlot.create({
      data: { userId: identity.userId, workspaceId: identity.workspaceId, scanId: identity.scanId },
    })
    const job = await queue.add(
      "scan",
      {
        scanId: identity.scanId,
        workspaceId: identity.workspaceId,
        targetId: identity.targetId,
        goal: "TEST_APP",
        mode: "STANDARD",
        drillNonce: nonce,
      },
      { jobId: identity.scanId, removeOnComplete: false, removeOnFail: false }
    )
    identity.timestamp = job.timestamp
    writeFileSync(identityFile, JSON.stringify(identity), { flag: "wx", mode: 0o644 })
    console.log("COLD_CLAIM_INITIALIZED")
  } else {
    assert.ok(phase === "interrupt" || phase === "resume")
    const identity = JSON.parse(readFileSync(identityFile))
    const original = await queue.getJob(identity.scanId)
    assert.ok(original)
    assert.equal(original.timestamp, identity.timestamp)
    if (phase === "resume") {
      assert.equal(await original.getState(), "active")
      assert.equal(original.attemptsStarted, 1)
      assert.equal(original.stalledCounter, 0)
      assert.deepEqual(await snapshot(identity), JSON.parse(readFileSync("/proof/claimed.json")))
    }
    const stalled = []
    worker = new Worker(
      SCAN_QUEUE_NAME,
      async (job, token) => {
        assert.equal(job.id, identity.scanId)
        assert.equal(job.data.drillNonce, identity.nonce)
        assert.equal(job.timestamp, identity.timestamp)
        assert.equal(await integrations.getRedis().get(queue.toKey(job.id + ":lock")), token)
        if (phase === "interrupt") {
          assert.equal(job.attemptsStarted, 1)
          const capacity = await db.runWithWorkspaceContext(identity.workspaceId, () =>
            claimEngineCapacity(2, identity.workspaceId, identity.scanId, 60000)
          )
          assert.equal(capacity.runtimeLimitMs, 55000)
          const before = await snapshot(identity)
          assert.equal(before.claim.length, 1)
          assert.equal(before.reservation.state, "RUNNING")
          assert.equal(before.reservation.fundedMinutes, 1)
          assert.equal(before.reservation.stoppedAt, null)
          writeFileSync("/proof/claimed.json", JSON.stringify(before), { flag: "wx", mode: 0o644 })
          console.log("COLD_CLAIM_DURABLE_BEFORE_PROVIDER")
          await new Promise(() => {}) // Host SIGKILLs this actual image/Worker process.
        }
        assert.equal(job.attemptsStarted, 2)
        assert.equal(job.stalledCounter, 1)
        const result = await processScanJob(job)
        assert.equal(result.errorCategory, "BILLABLE_PHASE_INTERRUPTED")
        assert.deepEqual(await snapshot(identity), JSON.parse(readFileSync("/proof/claimed.json")))
        assert.ok(!existsSync("/proof/provider-called") && !existsSync("/proof/engine-called"))
        return result
      },
      {
        connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null },
        autorun: false,
        concurrency: 1,
        lockDuration: 8000,
        stalledInterval: 1000,
        maxStalledCount: 1,
      }
    )
    worker.on("stalled", (id) => stalled.push(id))
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Actual cold claim worker timed out")), 60000)
      worker.once("completed", () => {
        clearTimeout(timer)
        resolve()
      })
      worker.once("failed", (_job, error) => {
        clearTimeout(timer)
        reject(error)
      })
      worker.once("error", reject)
      worker.run().catch(reject)
    })
    assert.deepEqual(stalled, [identity.scanId])
    const redelivered = await queue.getJob(identity.scanId)
    assert.equal(await redelivered.getState(), "completed")
    assert.equal(redelivered.attemptsStarted, 2)
    const receipt = {
      schema: "lyrashield.cold-paid-claim-image.v1",
      exitCode: 0,
      productRevision: process.env.COLD_PROBE_PRODUCT_REVISION,
      workerDigest: process.env.COLD_PROBE_WORKER_DIGEST,
      scanId: identity.scanId,
      actualStalledRedelivery: true,
      attemptsStarted: 2,
      stalledCounter: 1,
      billableClaimUnchanged: true,
      fundedReservationUnchanged: true,
      userSlotUnchanged: true,
      interruptedResult: "BILLABLE_PHASE_INTERRUPTED",
      executorStopProofAbsent: true,
      engineCalls: 0,
      providerCalls: 0,
      initialCheckpoint: "actual-funded-admission-before-provider",
    }
    writeFileSync("/proof/receipt.json", JSON.stringify(receipt) + "\n", {
      flag: "wx",
      mode: 0o644,
    })
    console.log(JSON.stringify(receipt))
  }
} finally {
  if (worker) await worker.close(true)
  await queue.close()
  await integrations.getRedis()?.quit()
  trap.close()
  await owner.$disconnect()
  await db.prisma.$disconnect()
}

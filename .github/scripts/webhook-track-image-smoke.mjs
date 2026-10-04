import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"

function requireDisposableEndpoints() {
  if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1") {
    throw new Error("Disposable database marker is required")
  }
  const runtime = new URL(process.env.DATABASE_URL ?? "")
  const owner = new URL(process.env.DATABASE_DIRECT_URL ?? "")
  const system = new URL(process.env.DATABASE_SYSTEM_URL ?? "")
  const redis = new URL(process.env.REDIS_URL ?? "")
  const localPostgresHosts = new Set(["localhost", "127.0.0.1", "postgres"])
  if (
    ![runtime, owner, system].every((url) => url.protocol === "postgresql:" && url.port === "5432") ||
    ![runtime.hostname, owner.hostname, system.hostname].every((host) =>
      localPostgresHosts.has(host)
    ) ||
    owner.hostname !== runtime.hostname ||
    owner.hostname !== system.hostname ||
    owner.pathname !== "/lyrashield" ||
    system.pathname !== owner.pathname ||
    runtime.pathname !== owner.pathname ||
    redis.protocol !== "redis:" ||
    !["localhost", "127.0.0.1", "redis"].includes(redis.hostname) ||
    redis.port !== "6379"
  ) {
    throw new Error("Refusing non-local or non-disposable integration endpoints")
  }
  if (
    runtime.username !== "app_runtime_ci" ||
    owner.username !== "lyrashield" ||
    system.username !== "lyrashield"
  ) {
    throw new Error("Disposable runtime and owner roles are required")
  }
}

// Validate before importing application modules or opening database clients.
requireDisposableEndpoints()

const [{ Worker }, db, { PrismaClient }, { createBoundedPgAdapter }, billing, integrations, worker] =
  await Promise.all([
    import("bullmq"),
    import("@lyrashield/db"),
    import("@lyrashield/db/src/generated/prisma"),
    import("@lyrashield/db/src/pool"),
    import("@lyrashield/billing"),
    import("@lyrashield/integrations"),
    import("./src/jobs/webhook-track-retry.job.ts"),
  ])

const owner = new PrismaClient({ adapter: createBoundedPgAdapter(process.env.DATABASE_DIRECT_URL) })
const queue = integrations.getWebhookTrackRetryQueue()
const eventId = `webhook-image-fixture-${randomUUID()}`
const jobIds = [0, 1, 2].map((generation) =>
  integrations.webhookTrackRetryJobId({ webhookEventId: eventId, track: "affiliate", generation })
)
const workers = []
let fixtureCreated = false

async function setDue() {
  await owner.webhookEventTrack.updateMany({
    where: { webhookEventId: eventId, track: "affiliate", status: "failed" },
    data: { nextAttemptAt: new Date(0), nextAttemptAtUtc: new Date(0) },
  })
}

async function consume(generation, handlers) {
  const jobId = await integrations.enqueueWebhookTrackRetry({
    webhookEventId: eventId,
    track: "affiliate",
    generation,
  })
  assert.equal(jobId, jobIds[generation])
  const runtimeWorker = new Worker(integrations.WEBHOOK_TRACK_RETRY_QUEUE_NAME, undefined, {
    connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null },
    autorun: false,
  })
  workers.push(runtimeWorker)
  await runtimeWorker.waitUntilReady()
  const token = randomUUID()
  const job = await runtimeWorker.getNextJob(token)
  assert.equal(job?.id, jobId)
  const result = await worker.processWebhookTrackRetry(job, handlers)
  await job.moveToCompleted(result, token, false)
  await runtimeWorker.close()
  return result
}

try {
  // This Redis service is created for this job run and contains no other data.
  await queue.drain(true)
  const payload = {
    type: "order.paid",
    data: {
      id: eventId,
      subscription_id: "sub_disposable_fixture",
      amount: 4900,
      currency: "USD",
    },
  }
  await owner.webhookEvent.create({
    data: {
      id: eventId,
      provider: "polar",
      eventType: "order.paid",
      externalId: eventId,
      payload,
      workspaceId: null,
    },
  })
  fixtureCreated = true
  await billing.ensureWebhookTrackRows(eventId, ["affiliate"])

  const [columns] = await owner.$queryRaw`
    SELECT count(*) FILTER (
      WHERE "nextAttemptAt" IS NOT NULL
        AND "nextAttemptAtUtc" IS DISTINCT FROM ("nextAttemptAt" AT TIME ZONE 'UTC')
    ) AS mismatches
    FROM "WebhookEventTrack"
    WHERE "webhookEventId" = ${eventId} AND track = 'affiliate'
  `
  assert.equal(columns.mismatches, 0n, "legacy and UTC scheduler columns must agree")

  let dispatchAttempts = 0
  const handlers = {
    dispatchAffiliate: async () => {
      dispatchAttempts += 1
      if (dispatchAttempts < 3) throw new Error(`disposable failure ${dispatchAttempts}`)
    },
  }

  assert.equal(
    await billing.retryWebhookTrack({
      webhookEventId: eventId,
      track: "affiliate",
      generation: 0,
      handlers,
    }),
    "failed"
  )
  await setDue()
  assert.equal((await consume(1, handlers)).outcome, "failed")

  const retained = await queue.getJob(jobIds[1])
  assert.equal(await retained?.getState(), "completed")
  await setDue()
  const next = await queue.getJob(jobIds[2])
  assert.ok(next, "the next retry generation must be retained")
  await next.promote()
  assert.equal((await consume(2, handlers)).outcome, "succeeded")

  const row = await owner.webhookEventTrack.findUniqueOrThrow({
    where: { webhookEventId_track: { webhookEventId: eventId, track: "affiliate" } },
  })
  assert.equal(row.status, "succeeded")
  assert.equal(row.attempts, 3)
  assert.equal(row.generation, 2)
  assert.equal(
    (await owner.webhookEvent.findUniqueOrThrow({ where: { id: eventId } })).processed,
    true
  )
  assert.equal(
    await billing.retryWebhookTrack({
      webhookEventId: eventId,
      track: "affiliate",
      generation: 1,
      handlers,
    }),
    "skipped_succeeded"
  )
  assert.equal(dispatchAttempts, 3)
  console.log("Exact worker image webhook retry recovery passed with disposable fixtures.")
} finally {
  for (const runtimeWorker of workers) await runtimeWorker.close()
  for (const jobId of jobIds) await (await queue.getJob(jobId))?.remove()
  await queue.close()
  await integrations.closeRedis()
  if (fixtureCreated) await owner.webhookEvent.deleteMany({ where: { id: eventId } })
  await owner.$disconnect()
  await db.prisma.$disconnect()
  await db.getSystemPrisma().$disconnect()
}

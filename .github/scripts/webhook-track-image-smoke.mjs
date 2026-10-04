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
const additionalEventIds = []
const additionalJobIds = []
const workers = []
let fixtureCreated = false
let rehearsalFailed = true

async function setDue(forEventId = eventId) {
  await owner.webhookEventTrack.updateMany({
    where: { webhookEventId: forEventId, track: "affiliate", status: "failed" },
    data: { nextAttemptAt: new Date(0), nextAttemptAtUtc: new Date(0) },
  })
}

async function consume(generation, handlers, forEventId = eventId) {
  const jobData = { webhookEventId: forEventId, track: "affiliate", generation }
  const jobId = await integrations.enqueueWebhookTrackRetry(jobData)
  assert.equal(jobId, integrations.webhookTrackRetryJobId(jobData))
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

function jobIdFor(forEventId, generation) {
  return integrations.webhookTrackRetryJobId({
    webhookEventId: forEventId,
    track: "affiliate",
    generation,
  })
}

async function createAdditionalFixture(forEventId) {
  const payload = {
    type: "order.paid",
    data: {
      id: forEventId,
      subscription_id: "sub_fixture_only",
      amount: 4900,
      currency: "USD",
      product_id: "fixture-worker-smoke-pro-monthly",
      metadata: { plan: "PRO", interval: "monthly", isFirstPayment: true },
    },
  }
  await owner.webhookEvent.create({
    data: {
      id: forEventId,
      provider: "polar",
      eventType: "order.paid",
      externalId: forEventId,
      payload,
      workspaceId: null,
    },
  })
  additionalEventIds.push(forEventId)
  for (let generation = 0; generation < 4; generation++)
    additionalJobIds.push(jobIdFor(forEventId, generation))
  await billing.ensureWebhookTrackRows(forEventId, ["affiliate"])
}

async function failQueuedBeforeClaim(forEventId, generation) {
  const jobId = jobIdFor(forEventId, generation)
  const retained = await queue.getJob(jobId)
  assert.ok(retained, "the retry job must be retained before the simulated worker crash")
  if ((await retained.getState()) === "delayed") await retained.promote()
  const runtimeWorker = new Worker(integrations.WEBHOOK_TRACK_RETRY_QUEUE_NAME, undefined, {
    connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null },
    autorun: false,
  })
  workers.push(runtimeWorker)
  await runtimeWorker.waitUntilReady()
  const token = randomUUID()
  const job = await runtimeWorker.getNextJob(token)
  assert.equal(job?.id, jobId)
  await job.moveToFailed(new Error("disposable crash before claim"), token, false)
  await runtimeWorker.close()
}

try {
  // This Redis service is created for this job run and contains no other data.
  await queue.drain(true)
  const payload = {
    type: "order.paid",
    data: {
      id: eventId,
      subscription_id: "sub_fixture_only",
      amount: 4900,
      currency: "USD",
      product_id: "fixture-worker-smoke-pro-monthly",
      metadata: {
        plan: "PRO",
        interval: "monthly",
        isFirstPayment: true,
      },
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
  const recoveryEventId = "webhook-image-recovery-fixture-" + randomUUID()
  await createAdditionalFixture(recoveryEventId)
  let recoveryAttempts = 0
  const recoveryHandlers = {
    dispatchAffiliate: async () => {
      recoveryAttempts += 1
      if (recoveryAttempts === 1) throw new Error("disposable pre-handoff failure")
    },
  }
  assert.equal(
    await billing.retryWebhookTrack({
      webhookEventId: recoveryEventId,
      track: "affiliate",
      generation: 0,
      handlers: recoveryHandlers,
    }),
    "failed"
  )
  await setDue(recoveryEventId)
  assert.deepEqual(await worker.recoverDueWebhookTrackRetries(), {
    examined: 1,
    represented: 1,
    ambiguous: 0,
  })
  assert.equal(
    (await owner.webhookEventTrack.findUniqueOrThrow({
      where: { webhookEventId_track: { webhookEventId: recoveryEventId, track: "affiliate" } },
    })).generation,
    1
  )

  // Keep the completed/failed BullMQ generation as evidence, then prove the
  // due sweep advances the durable row and represents the next generation.
  await failQueuedBeforeClaim(recoveryEventId, 1)
  await setDue(recoveryEventId)
  assert.deepEqual(await worker.recoverDueWebhookTrackRetries(), {
    examined: 1,
    represented: 1,
    ambiguous: 0,
  })
  assert.equal(await (await queue.getJob(jobIdFor(recoveryEventId, 1))).getState(), "failed")
  assert.ok(await queue.getJob(jobIdFor(recoveryEventId, 2)))
  const recovered = await owner.webhookEventTrack.findUniqueOrThrow({
    where: { webhookEventId_track: { webhookEventId: recoveryEventId, track: "affiliate" } },
  })
  assert.equal(recovered.generation, 2)
  assert.equal(recovered.attempts, 1)
  assert.equal((await consume(2, recoveryHandlers, recoveryEventId)).outcome, "succeeded")
  assert.equal(recoveryAttempts, 2)
  assert.equal(
    await billing.retryWebhookTrack({
      webhookEventId: recoveryEventId,
      track: "affiliate",
      generation: 1,
      handlers: recoveryHandlers,
    }),
    "skipped_succeeded"
  )

  const ambiguousEventId = "webhook-image-ambiguous-fixture-" + randomUUID()
  await createAdditionalFixture(ambiguousEventId)
  await owner.webhookEventTrack.updateMany({
    where: { webhookEventId: ambiguousEventId, track: "affiliate" },
    data: { nextAttemptAt: new Date(0), nextAttemptAtUtc: new Date(0) },
  })
  const claim = await billing.claimWebhookTrack(ambiguousEventId, "affiliate", 0)
  assert.equal(claim.outcome, "claimed")
  if (claim.outcome !== "claimed") throw new Error("disposable expired-claim fixture did not claim")
  let syntheticExternalEffects = 1 // Model an effect completed before the receipt was persisted.
  await owner.webhookEventTrack.updateMany({
    where: { webhookEventId: ambiguousEventId, track: "affiliate" },
    data: { leaseExpiresAt: new Date(0), leaseExpiresAtUtc: new Date(0) },
  })
  const ambiguousRecovery = await worker.recoverDueWebhookTrackRetries()
  assert.equal(ambiguousRecovery.ambiguous, 1)
  const ambiguousRow = await owner.webhookEventTrack.findUniqueOrThrow({
    where: { webhookEventId_track: { webhookEventId: ambiguousEventId, track: "affiliate" } },
  })
  assert.equal(ambiguousRow.status, "dead_letter")
  assert.equal(ambiguousRow.attempts, 1)
  assert.equal(ambiguousRow.lastError, "claim_expired_requires_receipt_review")
  assert.equal(await billing.markTrackSucceeded(claim.claim), false)
  assert.equal(await billing.markTrackFailed(claim.claim, new Error("late completion")), false)
  assert.equal(
    await billing.retryWebhookTrack({
      webhookEventId: ambiguousEventId,
      track: "affiliate",
      generation: 0,
      handlers: { dispatchAffiliate: async () => { syntheticExternalEffects += 1 } },
    }),
    "skipped_dead_letter"
  )
  assert.equal(syntheticExternalEffects, 1)
  assert.equal(await queue.getJob(jobIdFor(ambiguousEventId, 1)), undefined)

  const nullDueEventId = "webhook-image-null-due-fixture-" + randomUUID()
  await createAdditionalFixture(nullDueEventId)
  await owner.webhookEventTrack.updateMany({
    where: { webhookEventId: nullDueEventId, track: "affiliate" },
    data: { nextAttemptAt: null, nextAttemptAtUtc: null },
  })
  assert.deepEqual(await worker.recoverDueWebhookTrackRetries(), {
    examined: 0,
    represented: 0,
    ambiguous: 0,
  })
  let nullDueDispatches = 0
  assert.equal(
    await billing.retryWebhookTrack({
      webhookEventId: nullDueEventId,
      track: "affiliate",
      handlers: { dispatchAffiliate: async () => { nullDueDispatches += 1 } },
    }),
    "busy"
  )
  assert.equal(nullDueDispatches, 0)
  assert.equal(await queue.getJob(jobIdFor(nullDueEventId, 0)), undefined)

  assert.equal(dispatchAttempts, 3)
  rehearsalFailed = false
  console.log("Exact worker image retry and recovery sweep passed with disposable fixtures.")
} finally {
  let cleanupFailed = false
  const attemptCleanup = async (cleanup) => {
    try {
      await cleanup()
    } catch {
      cleanupFailed = true
    }
  }
  for (const runtimeWorker of workers) await attemptCleanup(() => runtimeWorker.close())
  for (const jobId of [...jobIds, ...additionalJobIds]) {
    await attemptCleanup(async () => (await queue.getJob(jobId))?.remove())
  }
  await attemptCleanup(() => queue.close())
  await attemptCleanup(() => integrations.closeRedis())
  if (fixtureCreated)
    await attemptCleanup(() => owner.webhookEvent.deleteMany({ where: { id: eventId } }))
  for (const extraEventId of additionalEventIds)
    await attemptCleanup(() => owner.webhookEvent.deleteMany({ where: { id: extraEventId } }))
  await attemptCleanup(() => owner.$disconnect())
  await attemptCleanup(() => db.prisma.$disconnect())
  await attemptCleanup(() => db.getSystemPrisma().$disconnect())
  if (cleanupFailed) {
    if (rehearsalFailed) console.error("Disposable rehearsal cleanup encountered an error.")
    else throw new Error("Disposable rehearsal cleanup encountered an error.")
  }
}

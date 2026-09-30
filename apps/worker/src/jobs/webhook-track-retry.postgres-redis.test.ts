import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Worker, type Job } from "bullmq"
import { PrismaClient } from "../../../../packages/db/src/generated/prisma"
import { createBoundedPgAdapter } from "../../../../packages/db/src/pool"

// Provider calls are the test seam. PostgreSQL claim/state updates, tenancy
// contexts, queue adds, retained jobs and job execution remain real.
vi.mock("../../../../packages/billing/src/providers/polar/adapter", () => ({
  processPolarEvent: vi.fn().mockResolvedValue({}),
}))
vi.mock("../../../../packages/billing/src/provider-catalog-validation", () => ({
  assertProviderCatalogEvent: vi.fn(),
}))
vi.mock("@lyrashield/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/config")>()
  return {
    ...actual,
    env: {
      ...actual.env,
      DATABASE_URL: process.env.RLS_RUNTIME_DATABASE_URL ?? actual.env.DATABASE_URL,
    },
  }
})

const enabled = process.env.WEBHOOK_TRACK_POSTGRES_REDIS_TEST === "1"
if (!enabled)
  console.warn(
    "[webhook.postgres-redis] SKIPPED: requires WEBHOOK_TRACK_POSTGRES_REDIS_TEST=1 and disposable PostgreSQL/Redis"
  )
let owner: PrismaClient
let db: typeof import("@lyrashield/db")
let billing: typeof import("@lyrashield/billing")
let integrations: typeof import("@lyrashield/integrations")
let workerModule: typeof import("./webhook-track-retry.job")
const eventIds: string[] = []
const workspaceIds: string[] = []
const jobs = new Set<string>()
const workers: Worker[] = []

async function fixture(workspaceId?: string) {
  const id = `webhook-fixture-${randomUUID()}`
  const payload = {
    type: "order.paid",
    data: {
      id,
      subscription_id: "sub_fixture",
      amount: 4900,
      currency: "USD",
      ...(workspaceId ? { metadata: { workspaceId } } : {}),
    },
  }
  eventIds.push(id)
  await owner.webhookEvent.create({
    data: { id, provider: "polar", eventType: "order.paid", externalId: id, payload, workspaceId },
  })
  await billing.ensureWebhookTrackRows(id, ["affiliate"])
  return {
    id,
    payload,
    event: billing.normalizeProviderEvent({
      provider: "polar",
      eventType: "order.paid",
      payload,
      deliveryId: id,
    }),
  }
}
async function row(id: string) {
  return owner.webhookEventTrack.findUniqueOrThrow({
    where: { webhookEventId_track: { webhookEventId: id, track: "affiliate" } },
  })
}
async function due(id: string) {
  await owner.webhookEventTrack.updateMany({
    where: { webhookEventId: id, status: "failed" },
    data: { nextAttemptAt: new Date(0) },
  })
}
async function enqueue(id: string, generation: number) {
  const jobId = await integrations.enqueueWebhookTrackRetry({
    webhookEventId: id,
    track: "affiliate",
    generation,
  })
  jobs.add(jobId)
  return jobId
}
async function consume(
  id: string,
  generation: number,
  handlers: Parameters<typeof workerModule.processWebhookTrackRetry>[1]
) {
  const queue = integrations.getWebhookTrackRetryQueue()
  const jobId = await enqueue(id, generation)
  const worker = new Worker(integrations.WEBHOOK_TRACK_RETRY_QUEUE_NAME, undefined, {
    connection: { url: process.env.REDIS_URL!, maxRetriesPerRequest: null },
    autorun: false,
  })
  workers.push(worker)
  await worker.waitUntilReady()
  const token = randomUUID()
  const job = await worker.getNextJob(token)
  expect(job?.id).toBe(jobId)
  const result = await workerModule.processWebhookTrackRetry(
    job as Job<import("@lyrashield/integrations").WebhookTrackRetryJobData>,
    handlers
  )
  await job!.moveToCompleted(result, token, false)
  if (result.retryRepresented) {
    const next = await row(id)
    jobs.add(
      integrations.webhookTrackRetryJobId({
        webhookEventId: id,
        track: "affiliate",
        generation: next.generation,
      })
    )
  }
  await worker.close()
  expect(await queue.getJob(jobId)).toBeDefined()
  return result
}

describe.skipIf(!enabled)("durable webhook retries on PostgreSQL and Redis", () => {
  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL
    const runtimeUrl = process.env.RLS_RUNTIME_DATABASE_URL
    const redisUrl = process.env.REDIS_URL
    if (!ownerUrl || !runtimeUrl || !redisUrl)
      throw new Error("Disposable owner/runtime PostgreSQL and Redis URLs required")
    const local = new Set(["localhost", "127.0.0.1", "[::1]", "postgres", "redis"])
    const ownerDatabase = new URL(ownerUrl),
      runtimeDatabase = new URL(runtimeUrl),
      redis = new URL(redisUrl)
    const disposable = new Set([
      "lyrashield",
      "lyrashield_test",
      "ls_hardening",
      "team_mutation_test",
    ])
    if (
      ![ownerDatabase.hostname, runtimeDatabase.hostname, redis.hostname].every((host) =>
        local.has(host)
      ) ||
      ownerDatabase.host !== runtimeDatabase.host ||
      ownerDatabase.pathname !== runtimeDatabase.pathname ||
      !disposable.has(ownerDatabase.pathname.slice(1))
    )
      throw new Error("Refusing non-local or non-disposable integration endpoints")
    owner = new PrismaClient({ adapter: createBoundedPgAdapter(ownerUrl) })
    db = await import("@lyrashield/db")
    billing = await import("@lyrashield/billing")
    integrations = await import("@lyrashield/integrations")
    workerModule = await import("./webhook-track-retry.job")
    const [role] = await db.prisma.$queryRaw<
      Array<{ superuser: boolean; bypass: boolean }>
    >`SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(role).toEqual({ superuser: false, bypass: false })
    await integrations.getWebhookTrackRetryQueue().waitUntilReady()
  }, 30_000)
  afterAll(async () => {
    for (const worker of workers) await worker.close()
    if (integrations) {
      const queue = integrations.getWebhookTrackRetryQueue()
      for (const id of jobs) await (await queue.getJob(id))?.remove()
      await queue.close()
      await integrations.closeRedis()
    }
    if (owner) {
      await owner.webhookEvent.deleteMany({ where: { id: { in: eventIds } } })
      await owner.workspace.deleteMany({ where: { id: { in: workspaceIds } } })
      await owner.$disconnect()
    }
    await db?.prisma.$disconnect()
    if (db) await db.getSystemPrisma().$disconnect()
  })

  it("two failures then success reserve exactly three attempts across retained generations", async () => {
    const f = await fixture()
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValue(undefined)
    const handlers = { dispatchAffiliate: handler }
    expect(
      await billing.retryWebhookTrack({
        webhookEventId: f.id,
        track: "affiliate",
        generation: 0,
        handlers,
      })
    ).toBe("failed")
    await due(f.id)
    expect((await consume(f.id, 1, handlers)).outcome).toBe("failed")
    // Next generation was scheduled while the previous generation was active.
    const retained = await integrations.getWebhookTrackRetryQueue().getJob(
      integrations.webhookTrackRetryJobId({
        webhookEventId: f.id,
        track: "affiliate",
        generation: 1,
      })
    )
    expect(await retained?.getState()).toBe("completed")
    await due(f.id)
    const nextId = integrations.webhookTrackRetryJobId({
      webhookEventId: f.id,
      track: "affiliate",
      generation: 2,
    })
    const next = await integrations.getWebhookTrackRetryQueue().getJob(nextId)
    await next?.promote()
    expect((await consume(f.id, 2, handlers)).outcome).toBe("succeeded")
    expect(await row(f.id)).toMatchObject({ status: "succeeded", attempts: 3, generation: 2 })
    expect((await owner.webhookEvent.findUniqueOrThrow({ where: { id: f.id } })).processed).toBe(
      true
    )
    expect(
      await billing.retryWebhookTrack({
        webhookEventId: f.id,
        track: "affiliate",
        generation: 1,
        handlers,
      })
    ).toBe("skipped_succeeded")
    expect(handler).toHaveBeenCalledTimes(3)
  })

  it("ingress and retry contend for one claim and never downgrade a terminal result", async () => {
    const f = await fixture()
    let release!: () => void
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const handler = vi.fn(async () => {
      started()
      await blocked
    })
    const handlers = { dispatchAffiliate: handler }
    const inline = billing.runApplicableTracks({
      webhookEventId: f.id,
      event: f.event,
      rawPayload: f.payload,
      handlers,
    })
    await startedPromise
    expect(
      await billing.retryWebhookTrack({
        webhookEventId: f.id,
        track: "affiliate",
        generation: 0,
        handlers,
      })
    ).toBe("busy")
    expect(await row(f.id)).toMatchObject({ status: "processing", attempts: 1 })
    release()
    expect((await inline).allSucceeded).toBe(true)
    expect(await row(f.id)).toMatchObject({ status: "succeeded", attempts: 1 })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("five total failed executions dead-letter and duplicate retries cannot extend the budget", async () => {
    const f = await fixture()
    const handler = vi.fn().mockRejectedValue(new Error("always fails"))
    for (let generation = 0; generation < 5; generation++) {
      await due(f.id)
      expect(
        await billing.retryWebhookTrack({
          webhookEventId: f.id,
          track: "affiliate",
          generation,
          handlers: { dispatchAffiliate: handler },
        })
      ).toBe(generation === 4 ? "dead_letter" : "failed")
    }
    expect(await row(f.id)).toMatchObject({
      status: "dead_letter",
      attempts: 5,
      nextAttemptAt: null,
    })
    expect(
      await billing.retryWebhookTrack({
        webhookEventId: f.id,
        track: "affiliate",
        generation: 4,
        handlers: { dispatchAffiliate: handler },
      })
    ).toBe("skipped_dead_letter")
    expect(handler).toHaveBeenCalledTimes(5)
  })

  it("crash before enqueue recovers only due generation and retains failed job history", async () => {
    const f = await fixture()
    expect(
      await billing.retryWebhookTrack({
        webhookEventId: f.id,
        track: "affiliate",
        generation: 0,
        handlers: {
          dispatchAffiliate: vi.fn().mockRejectedValue(new Error("failed before handoff")),
        },
      })
    ).toBe("failed")
    expect((await workerModule.recoverDueWebhookTrackRetries()).examined).toBe(0)
    await due(f.id)
    const jobId = await enqueue(f.id, 1)
    const worker = new Worker(integrations.WEBHOOK_TRACK_RETRY_QUEUE_NAME, undefined, {
      connection: { url: process.env.REDIS_URL!, maxRetriesPerRequest: null },
      autorun: false,
    })
    workers.push(worker)
    const token = randomUUID()
    const job = await worker.getNextJob(token)
    expect(job?.id).toBe(jobId)
    await job!.moveToFailed(new Error("crash before claim"), token, false)
    await worker.close()
    expect((await workerModule.recoverDueWebhookTrackRetries()).represented).toBe(1)
    const current = await row(f.id)
    expect(current).toMatchObject({ generation: 2, attempts: 1 })
    jobs.add(
      integrations.webhookTrackRetryJobId({
        webhookEventId: f.id,
        track: "affiliate",
        generation: 2,
      })
    )
    expect(await (await integrations.getWebhookTrackRetryQueue().getJob(jobId))?.getState()).toBe(
      "failed"
    )
    expect(
      (await consume(f.id, 2, { dispatchAffiliate: vi.fn().mockResolvedValue(undefined) })).outcome
    ).toBe("succeeded")
  })

  it("expired claim after external effect requires receipt review and rejects stale completion", async () => {
    const f = await fixture()
    const claimed = await billing.claimWebhookTrack(f.id, "affiliate", 0)
    expect(claimed.outcome).toBe("claimed")
    if (claimed.outcome !== "claimed") throw new Error("claim missing")
    // The external handler may finish without the process persisting its receipt.
    const effect = vi.fn().mockResolvedValue(undefined)
    await effect()
    await owner.webhookEventTrack.updateMany({
      where: { webhookEventId: f.id },
      data: { leaseExpiresAt: new Date(0) },
    })
    expect(await billing.renewWebhookTrackClaim(claimed.claim)).toBe(false)
    expect((await workerModule.recoverDueWebhookTrackRetries()).ambiguous).toBe(1)
    expect(await billing.markTrackSucceeded(claimed.claim)).toBe(false)
    expect(await billing.markTrackFailed(claimed.claim, new Error("late"))).toBe(false)
    expect(await row(f.id)).toMatchObject({
      status: "dead_letter",
      attempts: 1,
      lastError: "claim_expired_requires_receipt_review",
    })
    expect(
      await billing.retryWebhookTrack({
        webhookEventId: f.id,
        track: "affiliate",
        handlers: { dispatchAffiliate: effect },
      })
    ).toBe("skipped_dead_letter")
    expect(effect).toHaveBeenCalledTimes(1)
  })

  it("lease expiry during a slow handler blocks takeover and fences its late completion", async () => {
    const f = await fixture()
    let release!: () => void
    let started!: () => void
    const start = new Promise<void>((resolve) => {
      started = resolve
    })
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const handler = vi.fn(async () => {
      started()
      await wait
    })
    const running = billing.retryWebhookTrack({
      webhookEventId: f.id,
      track: "affiliate",
      generation: 0,
      handlers: { dispatchAffiliate: handler },
    })
    await start
    const owned = await row(f.id)
    const claim = {
      webhookEventId: f.id,
      track: "affiliate" as const,
      generation: owned.generation,
      attempts: owned.attempts,
      token: owned.claimToken!,
    }
    expect(await billing.renewWebhookTrackClaim(claim)).toBe(true)
    expect((await row(f.id)).leaseExpiresAt!.getTime()).toBeGreaterThanOrEqual(
      owned.leaseExpiresAt!.getTime()
    )
    await owner.webhookEventTrack.updateMany({
      where: { webhookEventId: f.id },
      data: { leaseExpiresAt: new Date(0) },
    })
    expect(
      await billing.retryWebhookTrack({
        webhookEventId: f.id,
        track: "affiliate",
        generation: 0,
        handlers: { dispatchAffiliate: handler },
      })
    ).toBe("skipped_dead_letter")
    release()
    expect(await running).toBe("busy")
    expect(await row(f.id)).toMatchObject({ status: "dead_letter", attempts: 1 })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("receipt write failure after handler success never schedules automatic effect replay", async () => {
    const f = await fixture()
    const handler = vi.fn().mockResolvedValue(undefined)
    const original = db.prisma.$executeRaw.bind(db.prisma)
    const spy = vi.spyOn(db.prisma, "$executeRaw").mockImplementation(async (...args) => {
      const sql = args[0]
      if (Array.isArray(sql) && sql.join(" ").includes("SET status = 'succeeded'"))
        throw new Error("receipt write interrupted")
      return original(...args)
    })
    try {
      await expect(
        billing.retryWebhookTrack({
          webhookEventId: f.id,
          track: "affiliate",
          generation: 0,
          handlers: { dispatchAffiliate: handler },
        })
      ).rejects.toThrow("receipt write interrupted")
    } finally {
      spy.mockRestore()
    }
    expect(await row(f.id)).toMatchObject({
      status: "processing",
      attempts: 1,
      nextAttemptAt: null,
    })
    expect((await workerModule.recoverDueWebhookTrackRetries()).examined).toBe(0)
    await owner.webhookEventTrack.updateMany({
      where: { webhookEventId: f.id },
      data: { leaseExpiresAt: new Date(0) },
    })
    expect(
      await billing.retryWebhookTrack({
        webhookEventId: f.id,
        track: "affiliate",
        generation: 0,
        handlers: { dispatchAffiliate: handler },
      })
    ).toBe("skipped_dead_letter")
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("automatically renews the lease while the real handler remains slow", async () => {
    const f = await fixture()
    let release!: () => void
    let started!: () => void
    const start = new Promise<void>((resolve) => {
      started = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const handler = vi.fn(async () => {
      started()
      await blocked
    })
    const running = billing.retryWebhookTrack({
      webhookEventId: f.id,
      track: "affiliate",
      generation: 0,
      handlers: { dispatchAffiliate: handler },
    })
    await start
    const before = new Date(Date.now() + 45_000)
    await owner.webhookEventTrack.updateMany({
      where: { webhookEventId: f.id },
      data: { leaseExpiresAt: before },
    })
    try {
      // This waits for runClaimedTrack's actual thirty-second renewal timer;
      // no direct renewal call or mocked timer participates.
      await new Promise<void>((resolve) => setTimeout(resolve, 31_000))
      await vi.waitFor(
        async () => {
          expect((await row(f.id)).leaseExpiresAt!.getTime()).toBeGreaterThan(
            before.getTime() + 60_000
          )
        },
        { timeout: 5_000, interval: 250 }
      )
      expect(await billing.claimWebhookTrack(f.id, "affiliate", 0)).toEqual({ outcome: "busy" })
    } finally {
      release()
    }
    expect(await running).toBe("succeeded")
    expect(await row(f.id)).toMatchObject({ status: "succeeded", attempts: 1 })
    expect(handler).toHaveBeenCalledTimes(1)
  }, 45_000)

  it("binds a non-null stored workspace and denies foreign or unbound runtime reads", async () => {
    const own = `webhook-workspace-${randomUUID()}`
    const foreign = `webhook-workspace-${randomUUID()}`
    for (const id of [own, foreign]) {
      workspaceIds.push(id)
      await owner.workspace.create({ data: { id, slug: id, name: id } })
    }
    const f = await fixture(own)
    expect(await db.prisma.webhookEvent.findUnique({ where: { id: f.id } })).toBeNull()
    expect(
      await db.runWithWorkspaceContext(foreign, () =>
        db.prisma.webhookEvent.findUnique({ where: { id: f.id } })
      )
    ).toBeNull()
    const handler = vi.fn().mockResolvedValue(undefined)
    expect(
      await db.runWithWorkspaceContext(foreign, () =>
        billing.retryWebhookTrack({
          webhookEventId: f.id,
          track: "affiliate",
          generation: 0,
          handlers: { dispatchAffiliate: handler },
        })
      )
    ).toBe("succeeded")
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: own }))
    const receipt = await db.runWithWorkspaceContext(own, () =>
      db.prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.id } })
    )
    expect(receipt.processed).toBe(true)
    expect(receipt.workspaceId).toBe(own)
    expect(await row(f.id)).toMatchObject({ status: "succeeded", attempts: 1 })
  })

  it("historical null-due tracks require receipt review even with zero recorded attempts", async () => {
    const f = await fixture()
    // Old executors saved attempts only after failure. An external effect can
    // therefore exist while the historical track still says pending/attempts=0.
    let effects = 0
    const handler = vi.fn(async () => {
      effects++
    })
    await handler()
    handler.mockClear()
    await owner.webhookEventTrack.updateMany({
      where: { webhookEventId: f.id },
      data: { nextAttemptAt: null },
    })
    expect((await workerModule.recoverDueWebhookTrackRetries()).examined).toBe(0)
    expect(
      await billing.retryWebhookTrack({
        webhookEventId: f.id,
        track: "affiliate",
        handlers: { dispatchAffiliate: handler },
      })
    ).toBe("busy")
    expect(
      (
        await billing.runApplicableTracks({
          webhookEventId: f.id,
          event: f.event,
          rawPayload: f.payload,
          handlers: { dispatchAffiliate: handler },
        })
      ).allSucceeded
    ).toBe(false)
    const legacyFixture = {
      id: `${f.id}:affiliate`,
      data: { webhookEventId: f.id, track: "affiliate" },
    }
    const legacyJob = legacyFixture as Parameters<typeof workerModule.processWebhookTrackRetry>[0]
    expect(
      await workerModule.processWebhookTrackRetry(legacyJob, { dispatchAffiliate: handler })
    ).toEqual({ outcome: "busy", retryRepresented: false })
    expect(await row(f.id)).toMatchObject({
      status: "pending",
      attempts: 0,
      nextAttemptAt: null,
      claimToken: null,
    })
    const old = await fixture()
    await owner.webhookEventTrack.updateMany({
      where: { webhookEventId: old.id },
      data: { nextAttemptAt: null, attempts: 1, status: "failed" },
    })
    expect(
      await billing.retryWebhookTrack({
        webhookEventId: old.id,
        track: "affiliate",
        handlers: { dispatchAffiliate: handler },
      })
    ).toBe("busy")
    expect((await workerModule.recoverDueWebhookTrackRetries()).examined).toBe(0)
    expect(handler).not.toHaveBeenCalled()
    expect(effects).toBe(1)
  })
})

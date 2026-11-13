import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "../../../packages/db/src/generated/prisma"
import { createBoundedPgAdapter } from "../../../packages/db/src/pool"

vi.mock("@lyrashield/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/config")>()
  return { ...actual, env: { ...actual.env, DATABASE_URL: process.env.RLS_RUNTIME_DATABASE_URL } }
})
const enabled = process.env.SCHEDULE_ADMISSION_POSTGRES_TEST === "1"
let owner: PrismaClient
let db: typeof import("@lyrashield/db")
const users: string[] = []
const workspaces: string[] = []
const now = new Date("2026-10-30T12:00:00Z")
const next = new Date("2026-10-31T00:00:00Z")
async function fixture(userId = `schedule-user-${randomUUID()}`) {
  if (!users.includes(userId)) {
    users.push(userId)
    await owner.user.create({ data: { id: userId, name: userId, email: `${userId}@example.test` } })
  }
  const workspaceId = `schedule-workspace-${randomUUID()}`
  workspaces.push(workspaceId)
  await owner.workspace.create({ data: { id: workspaceId, name: workspaceId, slug: workspaceId } })
  const target = await owner.target.create({
    data: {
      workspaceId,
      type: "WEB_APP",
      name: "Fixture",
      url: `https://${randomUUID()}.example.test`,
    },
  })
  return owner.schedule.create({
    data: {
      workspaceId,
      targetId: target.id,
      createdById: userId,
      cron: "0 0 * * *",
      goal: "WEEKLY_MONITOR",
      mode: "SAFE",
      nextRunAt: new Date("2026-10-01T00:00:00Z"),
    },
  })
}

describe.skipIf(!enabled)("scheduled occurrence admission against disposable PostgreSQL", () => {
  beforeAll(async () => {
    const ownerUrl = new URL(process.env.DATABASE_URL!)
    const runtimeUrl = new URL(process.env.RLS_RUNTIME_DATABASE_URL!)
    if (
      ownerUrl.hostname !== "127.0.0.1" ||
      ownerUrl.port !== "55436" ||
      ownerUrl.pathname !== "/v26_schedule_test" ||
      runtimeUrl.host !== ownerUrl.host ||
      runtimeUrl.pathname !== ownerUrl.pathname
    )
      throw new Error("requires isolated v26_schedule_test")
    owner = new PrismaClient({ adapter: createBoundedPgAdapter(ownerUrl.toString()) })
    db = await import("@lyrashield/db")
    const [role] = await db.prisma.$queryRaw<
      Array<{ superuser: boolean; bypass: boolean }>
    >`SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(role).toEqual({ superuser: false, bypass: false })
  }, 60_000)
  afterAll(async () => {
    if (owner) {
      await owner.userScanSlot.deleteMany({ where: { userId: { in: users } } })
      await owner.scanCapacityReservation.deleteMany({ where: { userId: { in: users } } })
      await owner.workspace.deleteMany({ where: { id: { in: workspaces } } })
      await owner.user.deleteMany({ where: { id: { in: users } } })
      await owner.$disconnect()
    }
    await db?.prisma.$disconnect()
  })
  it("creates exactly one scan and occurrence across competing replicas, coalescing old cadence", async () => {
    const schedule = await fixture()
    const results = await Promise.all(
      Array.from({ length: 6 }, () => db.createScheduledScan(schedule, now, next))
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await owner.scan.count({ where: { workspaceId: schedule.workspaceId } })).toBe(1)
    expect(await owner.schedule.findUnique({ where: { id: schedule.id } })).toMatchObject({
      lastRunAt: now,
      nextRunAt: next,
      lastScanId: results.find(Boolean)!.id,
    })
    expect(await owner.userScanSlot.count({ where: { userId: schedule.createdById } })).toBe(1)
    expect(
      await owner.scanCapacityReservation.count({ where: { workspaceId: schedule.workspaceId } })
    ).toBe(1)
  })
  it("keeps the due occurrence when a different workspace holds the user's slot", async () => {
    const active = await fixture()
    await db.createScan({
      workspaceId: active.workspaceId,
      targetId: active.targetId,
      createdById: active.createdById,
      goal: "TEST_APP",
      mode: "SAFE",
    })
    const waiting = await fixture(active.createdById)
    await expect(db.createScheduledScan(waiting, now, next)).rejects.toMatchObject({
      code: "SCAN_ALREADY_ACTIVE",
    })
    expect(await owner.schedule.findUnique({ where: { id: waiting.id } })).toMatchObject({
      lastRunAt: null,
      nextRunAt: waiting.nextRunAt,
    })
    expect(await owner.scan.count({ where: { workspaceId: waiting.workspaceId } })).toBe(0)
  })
  it("admits one of two due schedules for one user and retains the other occurrence", async () => {
    const first = await fixture()
    const second = await fixture(first.createdById)
    const results = await Promise.allSettled([
      db.createScheduledScan(first, now, next),
      db.createScheduledScan(second, now, next),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    const pending = await owner.schedule.findMany({
      where: { id: { in: [first.id, second.id] }, lastRunAt: null },
    })
    expect(pending).toHaveLength(1)
    expect(pending[0]!.nextRunAt).toEqual(new Date("2026-10-01T00:00:00Z"))
    expect(await owner.scan.count({ where: { createdById: first.createdById } })).toBe(1)
  })
  it("rolls back the occurrence, scan and reservation when durable event creation fails", async () => {
    const schedule = await fixture()
    await owner.$executeRawUnsafe(
      `CREATE FUNCTION schedule_test_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM "Scan" WHERE id=NEW."scanId" AND "workspaceId"='${schedule.workspaceId}') THEN RAISE EXCEPTION 'injected_schedule_event_failure'; END IF; RETURN NEW; END $$`
    )
    await owner.$executeRawUnsafe(
      'CREATE TRIGGER schedule_test_event_failure BEFORE INSERT ON "ScanEvent" FOR EACH ROW EXECUTE FUNCTION schedule_test_event_failure()'
    )
    try {
      await expect(db.createScheduledScan(schedule, now, next)).rejects.toThrow(
        "injected_schedule_event_failure"
      )
      expect(await owner.schedule.findUnique({ where: { id: schedule.id } })).toMatchObject({
        lastRunAt: null,
        nextRunAt: schedule.nextRunAt,
      })
      expect(await owner.scan.count({ where: { workspaceId: schedule.workspaceId } })).toBe(0)
      expect(await owner.userScanSlot.count({ where: { userId: schedule.createdById } })).toBe(0)
      expect(
        await owner.scanCapacityReservation.count({ where: { workspaceId: schedule.workspaceId } })
      ).toBe(0)
    } finally {
      await owner.$executeRawUnsafe('DROP TRIGGER schedule_test_event_failure ON "ScanEvent"')
      await owner.$executeRawUnsafe("DROP FUNCTION schedule_test_event_failure()")
    }
    expect(await db.createScheduledScan(schedule, now, next)).not.toBeNull()
  })
  it("restores a proven unpublished failed occurrence, retaining its failure then admitting one replacement", async () => {
    const schedule = await fixture()
    const failed = (await db.createScheduledScan(schedule, now, next))!
    await db.updateScanStatus(failed.id, "FAILED", { errorCategory: "QUEUE" }, schedule.workspaceId)
    await db.releaseUnstartedScanSlot(schedule.workspaceId, failed.id)
    expect(await db.restoreUnsubmittedScheduleOccurrence(schedule, failed.id, now, next)).toBe(true)
    expect(await db.restoreUnsubmittedScheduleOccurrence(schedule, failed.id, now, next)).toBe(
      false
    )
    const pending = (await owner.schedule.findUnique({ where: { id: schedule.id } }))!
    const replacement = (await db.createScheduledScan(pending, now, next))!
    expect(replacement.id).not.toBe(failed.id)
    expect(await owner.scan.findUnique({ where: { id: failed.id } })).toMatchObject({
      status: "FAILED",
      errorCategory: "QUEUE",
    })
    expect(
      await owner.scan.count({ where: { workspaceId: schedule.workspaceId, status: "QUEUED" } })
    ).toBe(1)
  })
  it("executes one disposable queue job after a definitive first publication failure and safe retry", async () => {
    const schedule = await fixture()
    const api = await import("@lyrashield/integrations")
    const { Worker } = await import("bullmq")
    const { closeRedis } = await import("../../../packages/integrations/src/redis")
    const first = (await db.createScheduledScan(schedule, now, next))!
    await expect(
      api.enqueueScan({
        scanId: first.id,
        workspaceId: schedule.workspaceId,
        targetId: schedule.targetId,
        goal: schedule.goal,
        mode: schedule.mode,
      })
    ).rejects.toMatchObject({ name: "ScanEnqueueNotSubmittedError", scanId: first.id })
    await db.updateScanStatus(first.id, "FAILED", { errorCategory: "QUEUE" }, schedule.workspaceId)
    await db.releaseUnstartedScanSlot(schedule.workspaceId, first.id)
    expect(await db.restoreUnsubmittedScheduleOccurrence(schedule, first.id, now, next)).toBe(true)
    const pending = (await owner.schedule.findUnique({ where: { id: schedule.id } }))!
    const retry = (await db.createScheduledScan(pending, now, next))!
    const seen: string[] = []
    const workerId = `schedule-fixture-${randomUUID()}`
    const worker = new Worker(
      "scans",
      async (job) => {
        seen.push(job.id!)
      },
      { connection: { url: process.env.REDIS_URL!, maxRetriesPerRequest: null } }
    )
    try {
      await api.registerScanWorker(workerId)
      const completed = new Promise<void>((resolve) => worker.once("completed", () => resolve()))
      expect(
        await api.enqueueScan({
          scanId: retry.id,
          workspaceId: schedule.workspaceId,
          targetId: schedule.targetId,
          goal: schedule.goal,
          mode: schedule.mode,
        })
      ).toBe(retry.id)
      await completed
      expect(seen).toEqual([retry.id])
      expect(await api.getScanQueue().getJob(first.id)).toBeUndefined()
      expect(await db.restoreUnsubmittedScheduleOccurrence(schedule, retry.id, now, next)).toBe(
        false
      )
      await (await api.getScanQueue().getJob(retry.id))?.remove()
    } finally {
      await api.unregisterScanWorker(workerId)
      await worker.close()
      await api.getScanQueue().close()
      await closeRedis()
    }
  }, 15_000)
  it("never restores an ambiguous queued scan or an occurrence edited after creation", async () => {
    const schedule = await fixture()
    const scan = (await db.createScheduledScan(schedule, now, next))!
    expect(await db.restoreUnsubmittedScheduleOccurrence(schedule, scan.id, now, next)).toBe(false)
    await db.updateScanStatus(scan.id, "FAILED", { errorCategory: "QUEUE" }, schedule.workspaceId)
    await db.releaseUnstartedScanSlot(schedule.workspaceId, scan.id)
    await owner.schedule.update({
      where: { id: schedule.id },
      data: { enabled: false, updatedAt: new Date(now.getTime() + 1) },
    })
    expect(await db.restoreUnsubmittedScheduleOccurrence(schedule, scan.id, now, next)).toBe(false)
    expect(await owner.schedule.findUnique({ where: { id: schedule.id } })).toMatchObject({
      nextRunAt: next,
      enabled: false,
    })
  })
  it("does not run a stale schedule after its settings change", async () => {
    const schedule = await fixture()
    await owner.schedule.update({
      where: { id: schedule.id },
      data: { mode: "STANDARD", updatedAt: new Date(schedule.updatedAt.getTime() + 1) },
    })
    expect(await db.createScheduledScan(schedule, now, next)).toBeNull()
    expect(await owner.scan.count({ where: { workspaceId: schedule.workspaceId } })).toBe(0)
  })
  it("records and advances one permanently blocked occurrence without creating work", async () => {
    const schedule = await fixture()
    expect(
      await db.advanceBlockedSchedule(schedule, now, next, "DOMAIN_VERIFICATION_REQUIRED")
    ).toBe(true)
    expect(
      await db.advanceBlockedSchedule(schedule, now, next, "DOMAIN_VERIFICATION_REQUIRED")
    ).toBe(false)
    expect(await owner.schedule.findUnique({ where: { id: schedule.id } })).toMatchObject({
      lastRunAt: now,
      nextRunAt: next,
      lastBlockedAt: now,
      lastBlockedReason: "DOMAIN_VERIFICATION_REQUIRED",
    })
    expect(await owner.scan.count({ where: { workspaceId: schedule.workspaceId } })).toBe(0)
  })
  it("keysets past fifty deferred due rows including legacy null timestamps", async () => {
    const schedule = await fixture()
    await owner.schedule.updateMany({
      where: { workspaceId: { in: workspaces } },
      data: { enabled: false },
    })
    const prefix = `keyset-${randomUUID()}`
    const ids = Array.from({ length: 55 }, (_, i) => `${prefix}-${String(i).padStart(3, "0")}`)
    await owner.schedule.createMany({
      data: ids.map((id, i) => ({
        id,
        workspaceId: schedule.workspaceId,
        targetId: schedule.targetId,
        createdById: schedule.createdById,
        cron: "0 0 * * *",
        goal: "WEEKLY_MONITOR",
        mode: "SAFE",
        nextRunAt: i % 2 ? null : new Date("2026-10-01T00:00:00Z"),
      })),
    })
    const first = await db.getDueSchedules(now)
    expect(first.map((row) => row.id)).toEqual(ids.slice(0, 50))
    const second = await db.getDueSchedules(now, first.at(-1)!.id)
    expect(second.map((row) => row.id)).toEqual(ids.slice(50))
    expect(await owner.scan.count({ where: { workspaceId: schedule.workspaceId } })).toBe(0)
  })
  it("accepts a legacy null due timestamp once", async () => {
    const fixtureSchedule = await fixture()
    const schedule = await owner.schedule.update({
      where: { id: fixtureSchedule.id },
      data: { nextRunAt: null },
    })
    expect(await db.createScheduledScan(schedule, now, next)).not.toBeNull()
    expect(await db.createScheduledScan(schedule, now, next)).toBeNull()
  })
})

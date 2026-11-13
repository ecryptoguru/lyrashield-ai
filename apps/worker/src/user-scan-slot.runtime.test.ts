import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "../../../packages/db/src/generated/prisma"
import { createBoundedPgAdapter } from "../../../packages/db/src/pool"
import {
  assertUserScanSlotRedisFixture,
  withUserScanSlotQueueFixture,
} from "./user-scan-slot.fixture"

vi.mock("@lyrashield/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/config")>()
  return {
    ...actual,
    env: {
      ...actual.env,
      DATABASE_URL: process.env.RLS_RUNTIME_DATABASE_URL,
      DATABASE_SYSTEM_URL: process.env.DATABASE_URL,
    },
  }
})

const enabled = process.env.USER_SCAN_SLOT_RUNTIME_TEST === "1"
let owner: PrismaClient
let db: typeof import("@lyrashield/db")
let integrations: typeof import("@lyrashield/integrations")
const users: string[] = []
const workspaces: string[] = []

async function fixture(userId = `slot-user-${randomUUID()}`) {
  if (!users.includes(userId)) {
    users.push(userId)
    await owner.user.create({ data: { id: userId, name: userId, email: `${userId}@example.test` } })
  }
  const workspaceId = `slot-workspace-${randomUUID()}`
  workspaces.push(workspaceId)
  await owner.workspace.create({ data: { id: workspaceId, name: workspaceId, slug: workspaceId } })
  const target = await owner.target.create({
    data: { workspaceId, type: "WEB_APP", name: "Local slot fixture", url: "https://example.test" },
  })
  return {
    workspaceId,
    targetId: target.id,
    createdById: userId,
    goal: "TEST_APP",
    mode: "SAFE",
  } as const
}

if (!enabled)
  console.warn("[user-scan-slot.runtime] SKIPPED: explicit disposable-service opt-in required")

describe.skipIf(!enabled)("nonfinancial user admission with PostgreSQL RLS and Redis", () => {
  beforeAll(async () => {
    const { assertDisposableDatabasePair } =
      await import("../../../.github/scripts/vitest-database-env.mjs")
    assertDisposableDatabasePair(process.env)
    const ownerUrl = new URL(process.env.DATABASE_URL!)
    const runtimeUrl = new URL(process.env.RLS_RUNTIME_DATABASE_URL!)
    const redisUrl = new URL(process.env.REDIS_URL!)
    if (
      process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1" ||
      ownerUrl.hostname !== "127.0.0.1" ||
      !ownerUrl.pathname.startsWith("/task3_admission_test") ||
      runtimeUrl.host !== ownerUrl.host ||
      runtimeUrl.pathname !== ownerUrl.pathname ||
      redisUrl.hostname !== "127.0.0.1"
    )
      throw new Error("requires same-database task3_admission_test disposable local services")
    await assertUserScanSlotRedisFixture(
      redisUrl.toString(),
      process.env.USER_SCAN_SLOT_REDIS_FIXTURE_ID
    )
    owner = new PrismaClient({ adapter: createBoundedPgAdapter(ownerUrl.toString()) })
    db = await import("@lyrashield/db")
    integrations = await import("@lyrashield/integrations")
    const [role] = await db.prisma.$queryRaw<Array<{ superuser: boolean; bypass: boolean }>>`
      SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(role).toEqual({ superuser: false, bypass: false })
    const tables = await owner.$queryRaw<
      Array<{ name: string; enabled: boolean; forced: boolean }>
    >`
      SELECT relname AS name, relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class WHERE relname IN ('UserScanSlot', 'Scan', 'Target', 'Schedule', 'ScanEvent', 'agent_operations')`
    expect(tables).toHaveLength(6)
    for (const table of tables) expect(table).toMatchObject({ enabled: true, forced: true })
  }, 60_000)

  afterAll(async () => {
    if (integrations) {
      await integrations.getScanQueue().close()
      const { closeRedis } = await import("../../../packages/integrations/src/redis")
      await closeRedis()
    }
    if (owner) {
      await owner.userScanSlot.deleteMany({ where: { userId: { in: users } } })
      await owner.scanCapacityReservation.deleteMany({ where: { userId: { in: users } } })
      await owner.workspace.deleteMany({ where: { id: { in: workspaces } } })
      await owner.user.deleteMany({ where: { id: { in: users } } })
      await owner.$disconnect()
    }
    await db?.prisma.$disconnect()
    await db?.getSystemPrisma().$disconnect()
  })

  it("rejects missing and mismatched Redis ownership without mutating fixture keys", async () => {
    const redis = integrations.getRedis()!
    const before = (await redis.keys("*")).sort()
    await expect(assertUserScanSlotRedisFixture(process.env.REDIS_URL!, undefined)).rejects.toThrow(
      "requires explicit task-owned Redis fixture identity"
    )
    await expect(
      assertUserScanSlotRedisFixture(process.env.REDIS_URL!, randomUUID())
    ).rejects.toThrow("Redis fixture identity does not match the task-owned service")
    expect((await redis.keys("*")).sort()).toEqual(before)
  })

  it("admits exactly one simultaneous request for one user across workspaces", async () => {
    const first = await fixture()
    const second = await fixture(first.createdById)
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => db.createScan(i % 2 ? first : second))
    )
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const rejected = results.filter((result) => result.status === "rejected")
    expect(rejected).toHaveLength(7)
    for (const result of rejected) {
      expect(result.reason).toMatchObject({ code: "SCAN_ALREADY_ACTIVE" })
      expect(result.reason.message).not.toContain(first.workspaceId)
      expect(result.reason.message).not.toContain(second.workspaceId)
      expect(result.reason).not.toHaveProperty("scanId")
      expect(result.reason).not.toHaveProperty("workspaceId")
    }
    expect(await owner.scan.count({ where: { createdById: first.createdById } })).toBe(1)
    expect(await owner.userScanSlot.count({ where: { userId: first.createdById } })).toBe(1)
  })

  it("allows different users independently", async () => {
    const first = await fixture()
    const second = await fixture()
    const scans = await Promise.all([db.createScan(first), db.createScan(second)])
    expect(scans[0]!.createdById).not.toBe(scans[1]!.createdById)
    expect(
      await owner.userScanSlot.count({ where: { scanId: { in: scans.map((scan) => scan.id) } } })
    ).toBe(2)
  })

  it("binds slot RLS to the user across workspaces and clears pooled transaction context", async () => {
    const first = await fixture()
    const second = await fixture(first.createdById)
    const other = await fixture()
    const scan = await db.createScan(first)
    expect(
      await db.withWorkspaceRLS(first.workspaceId, (tx) => tx.userScanSlot.findMany())
    ).toEqual([])
    await db.withWorkspaceRLS(second.workspaceId, async (tx) => {
      await db.lockUserScanAdmission(tx, first.createdById)
      expect(await tx.userScanSlot.findMany()).toEqual([
        expect.objectContaining({ scanId: scan.id }),
      ])
      expect(await tx.scan.findMany({ where: { id: scan.id } })).toEqual([])
    })
    await db.withWorkspaceRLS(first.workspaceId, async (tx) => {
      await db.lockUserScanAdmission(tx, other.createdById)
      expect(await tx.userScanSlot.findMany()).toEqual([])
      expect(await tx.userScanSlot.deleteMany({ where: { scanId: scan.id } })).toEqual({ count: 0 })
    })
    await expect(
      db.withWorkspaceRLS(first.workspaceId, async (tx) => {
        await db.lockUserScanAdmission(tx, other.createdById)
        return tx.userScanSlot.create({
          data: { userId: first.createdById, scanId: randomUUID(), workspaceId: first.workspaceId },
        })
      })
    ).rejects.toThrow(/row.level security/i)
    expect(
      await db.withWorkspaceRLS(first.workspaceId, (tx) => tx.userScanSlot.findMany())
    ).toEqual([])
  })

  it("defers a stored schedule creator's occurrence when another workspace holds the slot", async () => {
    const first = await fixture()
    const second = await fixture(first.createdById)
    await db.createScan(first)
    const now = new Date()
    const due = new Date(now.getTime() - 60_000)
    const schedule = await owner.schedule.create({
      data: { ...second, cron: "0 0 * * *", nextRunAt: due },
    })
    await expect(
      db.createScheduledScan(schedule, now, new Date(now.getTime() + 60_000))
    ).rejects.toMatchObject({ code: "SCAN_ALREADY_ACTIVE" })
    expect(await owner.schedule.findUnique({ where: { id: schedule.id } })).toMatchObject({
      lastRunAt: null,
      nextRunAt: due,
    })
    expect(await owner.scan.count({ where: { workspaceId: second.workspaceId } })).toBe(0)
  })

  it("replays a durable idempotent operation without creating another scan", async () => {
    const input = await fixture()
    const params = {
      workspaceId: input.workspaceId,
      userId: input.createdById,
      operationName: "scan.create",
      idempotencyKey: randomUUID(),
      input,
    }
    const results = await Promise.all(
      Array.from({ length: 4 }, () => db.claimOrGetAgentOperation(params))
    )
    const claimed = results.find((result) => result.status === "NEW")!
    expect(results.filter((result) => result.status === "NEW")).toHaveLength(1)
    expect(results.filter((result) => result.status === "IN_PROGRESS")).toHaveLength(3)
    if (claimed.status !== "NEW") throw new Error("operation was not claimed")
    const scan = await db.createScan(input)
    await db.completeAgentOperation(claimed.operation.id, input.workspaceId, {
      resultReference: scan.id,
      result: { scanId: scan.id },
    })
    expect(await db.claimOrGetAgentOperation(params)).toMatchObject({
      status: "REPLAY",
      operation: { id: claimed.operation.id, resultReference: scan.id },
    })
    expect(
      await db.claimOrGetAgentOperation({ ...params, input: { ...input, targetId: "different" } })
    ).toMatchObject({ status: "CONFLICT" })
    expect(await owner.scan.count({ where: { createdById: input.createdById } })).toBe(1)
    await expect(db.createScan(input)).rejects.toMatchObject({ code: "SCAN_ALREADY_ACTIVE" })
  })

  it("retains the slot across different credential operation principals for the same creator", async () => {
    const input = await fixture()
    for (const apiKeyId of [randomUUID(), randomUUID()]) {
      expect(
        await db.claimOrGetAgentOperation({
          workspaceId: input.workspaceId,
          apiKeyId,
          operationName: "scan.create",
          idempotencyKey: "same-key",
          input,
        })
      ).toMatchObject({ status: "NEW" })
    }
    await db.createScan(input)
    await expect(db.createScan(input)).rejects.toMatchObject({ code: "SCAN_ALREADY_ACTIVE" })
    expect(await owner.userScanSlot.count({ where: { userId: input.createdById } })).toBe(1)
  })

  it("releases a proven unstarted cancellation and admits one replacement", async () => {
    const input = await fixture()
    const scan = await db.createScan(input)
    await db.cancelScan(scan.id, input.workspaceId)
    expect(await owner.userScanSlot.count({ where: { userId: input.createdById } })).toBe(0)
    expect((await db.createScan(input)).id).not.toBe(scan.id)
  })

  it("holds cancellation and unresolved finalization slots without confirmed termination", async () => {
    for (const status of ["RUNNING", "VERIFYING", "COMPLETED"] as const) {
      const input = await fixture()
      const scan = await db.createScan(input)
      // Simulate execution ownership only. No executor, provider or financial service runs.
      await owner.scanCapacityReservation.update({
        where: { scanId: scan.id },
        data: { state: "RUNNING" },
      })
      await owner.scan.update({
        where: { id: scan.id },
        data: { status, finalizationStartedAt: status === "RUNNING" ? null : new Date() },
      })
      if (status === "RUNNING") await db.cancelScan(scan.id, input.workspaceId)
      if (status === "VERIFYING")
        await expect(db.cancelScan(scan.id, input.workspaceId)).rejects.toThrow(
          "Scan finalization already started"
        )
      await db.releaseUnstartedScanSlot(input.workspaceId, scan.id)
      expect(await db.releaseStoppedScanSlot(input.workspaceId, scan.id)).toBe(false)
      await expect(db.createScan(input)).rejects.toMatchObject({ code: "SCAN_ALREADY_ACTIVE" })
      expect(await owner.userScanSlot.count({ where: { scanId: scan.id } })).toBe(1)
    }
  })

  it("keeps a queued Redis job and slot after the reconciliation timer", async () => {
    const input = await fixture()
    const scan = await db.createScan(input)
    await owner.scan.update({ where: { id: scan.id }, data: { updatedAt: new Date(0) } })
    const workerId = `slot-test-${randomUUID()}`
    await withUserScanSlotQueueFixture(integrations, workerId, scan.id, async () => {
      await integrations.enqueueScan({
        scanId: scan.id,
        workspaceId: input.workspaceId,
        targetId: input.targetId,
        goal: "TEST_APP",
        mode: "SAFE",
      })
      const { reconcileExactQueuedScanOrphan } = await import("./queue-reconciliation")
      expect(await reconcileExactQueuedScanOrphan(scan.id, input.workspaceId)).toMatchObject({
        reconciled: false,
        jobState: "waiting",
      })
      expect(await owner.userScanSlot.count({ where: { scanId: scan.id } })).toBe(1)
      await expect(db.createScan(input)).rejects.toMatchObject({ code: "SCAN_ALREADY_ACTIVE" })
    })
  })

  it("removes the exact queued job and unregisters its worker after an assertion failure", async () => {
    const input = await fixture()
    const scan = await db.createScan(input)
    const workerId = `slot-failure-${randomUUID()}`
    await expect(
      withUserScanSlotQueueFixture(integrations, workerId, scan.id, async () => {
        await integrations.enqueueScan({
          scanId: scan.id,
          workspaceId: input.workspaceId,
          targetId: input.targetId,
          goal: "TEST_APP",
          mode: "SAFE",
        })
        throw new Error("injected fixture assertion failure")
      })
    ).rejects.toThrow("injected fixture assertion failure")
    expect(await integrations.getScanQueue().getJob(scan.id)).toBeUndefined()
    expect(await integrations.getRedis()!.zscore("lyrashield:scan-workers", workerId)).toBeNull()
  })

  it("reconciles missing queue jobs without replay and retains uncertain execution ownership", async () => {
    const { reconcileExactQueuedScanOrphan } = await import("./queue-reconciliation")
    for (const executionStarted of [false, true]) {
      const input = await fixture()
      const scan = await db.createScan(input)
      if (executionStarted)
        await owner.scanCapacityReservation.update({
          where: { scanId: scan.id },
          data: { state: "RUNNING" },
        })
      await owner.scan.update({ where: { id: scan.id }, data: { updatedAt: new Date(0) } })
      expect(await reconcileExactQueuedScanOrphan(scan.id, input.workspaceId)).toMatchObject({
        reconciled: true,
        jobState: "missing",
      })
      expect(await integrations.getScanQueue().getJob(scan.id)).toBeUndefined()
      expect(await owner.userScanSlot.count({ where: { scanId: scan.id } })).toBe(
        executionStarted ? 1 : 0
      )
      if (executionStarted)
        await expect(db.createScan(input)).rejects.toMatchObject({ code: "SCAN_ALREADY_ACTIVE" })
      else expect((await db.createScan(input)).id).not.toBe(scan.id)
    }
  })
})

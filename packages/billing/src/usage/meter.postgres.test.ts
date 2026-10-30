import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { PrismaClient, type Prisma } from "../../../db/src/generated/prisma"
import { createBoundedPgAdapter } from "../../../db/src/pool"

const coordination = vi.hoisted(() => ({
  afterReceiptRead: undefined as (() => Promise<void>) | undefined,
  transactionErrors: [] as unknown[],
}))

// Use the actual clients, RLS contexts, locks and transactions. The sole hook
// coordinates an independent legacy writer after the real receipt read.
vi.mock("@lyrashield/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/db")>()
  const withWorkspaceRLS: typeof actual.withWorkspaceRLS = (workspaceId, callback, options) =>
    actual
      .withWorkspaceRLS(
        workspaceId,
        async (tx) => {
          if (options?.isolationLevel === "Serializable" && coordination.afterReceiptRead) {
            const coordinated = new Proxy(tx, {
              get(target, key) {
                if (key !== "usageRecord") return Reflect.get(target, key)
                return {
                  ...target.usageRecord,
                  findUnique: async (args: Parameters<typeof tx.usageRecord.findUnique>[0]) => {
                    const receipt = await tx.usageRecord.findUnique(args)
                    const hook = coordination.afterReceiptRead
                    coordination.afterReceiptRead = undefined
                    await hook?.()
                    return receipt
                  },
                }
              },
            })
            return callback(coordinated)
          }
          return callback(tx)
        },
        options
      )
      .catch((error: unknown) => {
        coordination.transactionErrors.push(error)
        throw error
      })
  return { ...actual, withWorkspaceRLS }
})

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

const enabled = process.env.BILLING_METER_POSTGRES_TEST === "1"
const cycleStart = new Date("2026-09-01T00:00:00.000Z")
let owner: PrismaClient
let db: typeof import("@lyrashield/db")
let recordAgentMinutes: typeof import("./meter").recordAgentMinutes
let hasUnsettledScanIntent: typeof import("./meter").hasUnsettledScanIntent
const accounts: string[] = []
const workspaces: string[] = []

if (!enabled) {
  console.warn(
    "[meter.postgres] SKIPPED: requires BILLING_METER_POSTGRES_TEST=1 and disposable DATABASE_URL/RLS_RUNTIME_DATABASE_URL"
  )
}

async function fixture(pool = 0, pack = 0) {
  const accountId = `meter-account-${randomUUID()}`
  const workspaceIds = [0, 1].map(() => `meter-workspace-${randomUUID()}`)
  const scanIds = [0, 1].map(() => `meter-scan-${randomUUID()}`)
  accounts.push(accountId)
  workspaces.push(...workspaceIds)
  await owner.user.create({
    data: { id: accountId, name: accountId, email: `${accountId}@example.test` },
  })
  for (const [index, workspaceId] of workspaceIds.entries()) {
    await owner.workspace.create({
      data: { id: workspaceId, name: workspaceId, slug: workspaceId },
    })
    await owner.scan.create({
      data: {
        id: scanIds[index]!,
        workspaceId,
        createdById: accountId,
        goal: "LAUNCH_REVIEW",
        mode: "STANDARD",
        status: "RUNNING",
      },
    })
  }
  await owner.billingAccount.create({
    data: {
      accountId,
      workspaceId: workspaceIds[0],
      provider: "test",
      externalId: accountId,
      status: "active",
      currentPlan: "PRO",
      interval: "monthly",
      currentPeriodStart: cycleStart,
    },
  })
  if (pool)
    await owner.usageRecord.create({
      data: {
        accountId,
        workspaceId: workspaceIds[0],
        kind: "pool_grant",
        quantity: pool,
        cycleStart,
        idempotencyKey: `${accountId}:grant`,
      },
    })
  if (pack)
    await owner.minutePack.create({
      data: {
        accountId,
        workspaceId: workspaceIds[0],
        provider: "test",
        externalId: accountId,
        minutes: pack,
        remainingMinutes: pack,
      },
    })
  const workspaceId = workspaceIds[0]!
  const scanId = scanIds[0]!
  const idempotencyKey = `${workspaceId}:${scanId}:engine_run`
  return { accountId, workspaceId, workspaceIds, scanId, scanIds, idempotencyKey }
}

async function enableCapacity(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: "STANDARD" | "DEEP" = "STANDARD"
) {
  const now = new Date()
  await owner.billingAccount.updateMany({
    where: { accountId: f.accountId },
    data: { currentPeriodStart: now, graceCycleStart: now },
  })
  await owner.usageRecord.updateMany({
    where: { accountId: f.accountId },
    data: { cycleStart: now },
  })
  await owner.scan.updateMany({
    where: { id: { in: f.scanIds } },
    data: { accountingVersion: 2, mode },
  })
  for (const [index, scanId] of f.scanIds.entries())
    await owner.scanCapacityReservation.create({
      data: {
        scanId,
        accountId: f.accountId,
        userId: f.accountId,
        workspaceId: f.workspaceIds[index]!,
        multiplier: mode === "DEEP" ? 3 : 1,
        // Deterministic FIFO order across separate physical workspaces.
        createdAt: new Date(now.getTime() + index),
      },
    })
  const { reserveScanCapacity } = await import("./capacity")
  return { reserveScanCapacity, now }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
async function insertReceipt(
  f: Fixture,
  overrides: Partial<Prisma.UsageRecordUncheckedCreateInput> = {}
) {
  return owner.usageRecord.create({
    data: {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      kind: "agent_minutes",
      quantity: 3,
      cycleStart,
      idempotencyKey: f.idempotencyKey,
      metadata: { scanId: f.scanId, accountId: f.accountId, overageMinutes: 2 },
      ...overrides,
    },
  })
}
async function ledger(f: Fixture) {
  return {
    usage: await owner.usageRecord.findMany({
      where: { accountId: f.accountId, kind: "agent_minutes" },
      orderBy: { id: "asc" },
    }),
    packs: await owner.minutePack.findMany({
      where: { accountId: f.accountId },
      orderBy: { id: "asc" },
    }),
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// A bounded observation poll confirms the second transaction is actually
// waiting on a PostgreSQL advisory lock before releasing the first writer.
async function waitForContendingTransaction() {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const [row] = await owner.$queryRaw<Array<{ waiting: bigint }>>`
      SELECT count(*) AS waiting FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND NOT l.granted AND a.datname = current_database()`
    if (row && row.waiting > 0n) return
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error("No contending PostgreSQL metering transaction observed")
}

describe.skipIf(!enabled)("agent-minute metering against disposable PostgreSQL", () => {
  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL
    const runtimeUrl = process.env.RLS_RUNTIME_DATABASE_URL
    if (!ownerUrl || !runtimeUrl)
      throw new Error("Metering integration requires owner and runtime database URLs")
    const ownerDatabase = new URL(ownerUrl)
    const runtimeDatabase = new URL(runtimeUrl)
    const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"])
    const disposableDatabases = new Set(["lyrashield_test", "ls_hardening"])
    if (process.env.CI === "true") disposableDatabases.add("lyrashield")
    if (
      !localHosts.has(ownerDatabase.hostname) ||
      !localHosts.has(runtimeDatabase.hostname) ||
      ownerDatabase.host !== runtimeDatabase.host ||
      ownerDatabase.pathname !== runtimeDatabase.pathname ||
      !disposableDatabases.has(ownerDatabase.pathname.slice(1))
    ) {
      throw new Error("Metering tests require same-database local disposable PostgreSQL URLs")
    }
    owner = new PrismaClient({ adapter: createBoundedPgAdapter(ownerUrl) })
    db = await import("@lyrashield/db")
    ;({ recordAgentMinutes, hasUnsettledScanIntent } = await import("./meter"))
    const [role] = await db.prisma.$queryRaw<Array<{ superuser: boolean; bypass_rls: boolean }>>`
      SELECT rolsuper AS superuser, rolbypassrls AS bypass_rls FROM pg_roles WHERE rolname = current_user`
    expect(role).toEqual({ superuser: false, bypass_rls: false })
    const tables = await owner.$queryRaw<
      Array<{ name: string; enabled: boolean; forced: boolean }>
    >`
      SELECT relname AS name, relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('UsageRecord', 'MinutePack', 'BillingAccount', 'Scan')`
    expect(tables).toHaveLength(4)
    expect(tables.every((table) => table.enabled && table.forced)).toBe(true)
  })

  afterEach(() => {
    coordination.afterReceiptRead = undefined
    coordination.transactionErrors.length = 0
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    try {
      if (owner && accounts.length) {
        // Cleanup is limited to this run's random fixture IDs.
        await owner.userScanSlot.deleteMany({ where: { userId: { in: accounts } } })
        await owner.scanCapacityReservation.deleteMany({ where: { accountId: { in: accounts } } })
        await owner.usageRecord.deleteMany({ where: { accountId: { in: accounts } } })
        await owner.minutePack.deleteMany({ where: { accountId: { in: accounts } } })
        await owner.billingAccount.deleteMany({ where: { accountId: { in: accounts } } })
        await owner.workspace.deleteMany({ where: { id: { in: workspaces } } })
        await owner.user.deleteMany({ where: { id: { in: accounts } } })
      }
    } finally {
      await owner?.$disconnect()
      await db?.prisma.$disconnect()
    }
  })

  it("preserves covered usage when the last grace minute is consumed", async () => {
    const f = await fixture(1, 1)
    await owner.billingAccount.updateMany({
      where: { accountId: f.accountId },
      data: { graceUsedMs: 14 * 60_000 },
    })
    const { reserveScanCapacity } = await enableCapacity(f)
    expect(
      await reserveScanCapacity({
        workspaceId: f.workspaceId,
        scanId: f.scanId,
        maxRuntimeMs: 180_000,
        start: true,
      })
    ).toMatchObject({ state: "RUNNING", runtimeLimitMs: 175_000, fundedMinutes: 3 })
    const { enterGrace } = await import("../grace")
    const result = await recordAgentMinutes(f.workspaceId, f.scanId, 3 * 60_000, {
      phase: "engine_run",
      cycleStart,
      settleOverage: async (tx, minutes) => {
        const grace = await enterGrace(f.accountId, minutes * 60_000, tx)
        if (!grace.shouldContinue) throw new Error("AGENT_MINUTES_EXHAUSTED")
      },
    })
    expect(result.minutes).toBe(3)
    expect((await ledger(f)).usage).toHaveLength(1)
    expect((await ledger(f)).packs[0]?.remainingMinutes).toBe(0)
  })

  it("serializes real cross-workspace reservations and leaves a capacity waiter unfunded", async () => {
    const f = await fixture(2)
    await owner.billingAccount.updateMany({
      where: { accountId: f.accountId },
      data: { graceUsedMs: 900_000 },
    })
    const { reserveScanCapacity } = await enableCapacity(f)
    const results = await Promise.all(
      f.scanIds.map((scanId, i) =>
        reserveScanCapacity({
          scanId,
          workspaceId: f.workspaceIds[i]!,
          maxRuntimeMs: 120_000,
          start: true,
        })
      )
    )
    expect(results[0]).toMatchObject({
      state: "RUNNING",
      fundedMinutes: 2,
      runtimeLimitMs: 115_000,
    })
    expect(results[1]).toEqual({ state: "WAITING" })
    const waiting = await owner.scanCapacityReservation.findUniqueOrThrow({
      where: { scanId: f.scanIds[1] },
    })
    expect(waiting.fundedMinutes).toBe(0)
    expect(waiting.state).toBe("WAITING")
  })

  it("reserves the same sponsor across different initiating users and respects FIFO", async () => {
    const f = await fixture(2)
    const { reserveScanCapacity } = await enableCapacity(f)
    const otherUser = `meter-account-${randomUUID()}`
    accounts.push(otherUser)
    await owner.user.create({
      data: { id: otherUser, name: otherUser, email: `${otherUser}@example.test` },
    })
    await owner.scan.update({
      where: { id: f.scanIds[1] },
      data: { createdById: otherUser, sponsorAccountId: f.accountId },
    })
    await owner.scanCapacityReservation.update({
      where: { scanId: f.scanIds[1] },
      data: { userId: otherUser },
    })
    expect(
      await reserveScanCapacity({
        scanId: f.scanIds[1]!,
        workspaceId: f.workspaceIds[1]!,
        maxRuntimeMs: 120_000,
      })
    ).toEqual({ state: "WAITING" })
    expect(
      await reserveScanCapacity({
        scanId: f.scanId,
        workspaceId: f.workspaceId,
        maxRuntimeMs: 120_000,
        start: true,
      })
    ).toMatchObject({ fundedMinutes: 2 })
    expect(
      await reserveScanCapacity({
        scanId: f.scanIds[1]!,
        workspaceId: f.workspaceIds[1]!,
        maxRuntimeMs: 60_000,
        start: true,
      })
    ).toMatchObject({ state: "RUNNING", fundedMinutes: 1 })
  })

  it.each([
    ["pack", "partial"],
    ["pack", "failed"],
    ["grace", "partial"],
    ["grace", "failed"],
    ["overage", "partial"],
    ["overage", "failed"],
  ] as const)(
    "returns unused pool after a second user settles %s before the pool holder is %s",
    async (source, outcome) => {
      const f = await fixture(10, source === "pack" ? 5 : 0)
      const { reserveScanCapacity } = await enableCapacity(f)
      if (source === "overage")
        await owner.billingAccount.updateMany({
          where: { accountId: f.accountId },
          data: { currentPlan: "LAUNCH_ASSURANCE", spendLimitCents: 75 },
        })
      const otherUser = `meter-account-${randomUUID()}`
      accounts.push(otherUser)
      await owner.user.create({
        data: { id: otherUser, name: otherUser, email: `${otherUser}@example.test` },
      })
      await owner.scan.update({
        where: { id: f.scanIds[1] },
        data: { createdById: otherUser, sponsorAccountId: f.accountId },
      })
      await owner.scanCapacityReservation.update({
        where: { scanId: f.scanIds[1] },
        data: { userId: otherUser },
      })
      await reserveScanCapacity({
        workspaceId: f.workspaceId,
        scanId: f.scanId,
        maxRuntimeMs: 600_000,
        start: true,
      })
      await reserveScanCapacity({
        workspaceId: f.workspaceIds[1]!,
        scanId: f.scanIds[1]!,
        maxRuntimeMs: 300_000,
        start: true,
      })
      const second = await owner.scanCapacityReservation.findUniqueOrThrow({
        where: { scanId: f.scanIds[1] },
      })
      expect(second).toMatchObject({ poolMinutes: 0, fundedMinutes: 5, [`${source}Minutes`]: 5 })
      await recordAgentMinutes(f.workspaceIds[1]!, f.scanIds[1]!, 300_000, { phase: "engine_run" })
      const { confirmScanCapacityStopped } = await import("./capacity")
      await owner.scan.update({ where: { id: f.scanIds[1] }, data: { status: "COMPLETED" } })
      await confirmScanCapacityStopped(f.workspaceIds[1]!, f.scanIds[1]!)
      if (outcome === "partial")
        await recordAgentMinutes(f.workspaceId, f.scanId, 300_000, { phase: "engine_run" })
      await owner.scan.update({
        where: { id: f.scanId },
        data: { status: outcome === "partial" ? "PARTIAL" : "FAILED" },
      })
      await confirmScanCapacityStopped(f.workspaceId, f.scanId)
      const { getUsageBalance } = await import("./balance")
      expect(await getUsageBalance(f.accountId)).toMatchObject({
        poolRemaining: outcome === "partial" ? 5 : 10,
        poolConsumed: outcome === "partial" ? 5 : 0,
        packConsumed: source === "pack" ? 5 : 0,
        overageConsumed: source === "overage" ? 5 : 0,
      })
      const receipts = await ledger(f)
      expect(receipts.usage.reduce((n, row) => n + row.quantity, 0)).toBe(
        outcome === "partial" ? 10 : 5
      )
      // The next real admission can fund its entire runtime from the released pool.
      const next = await owner.scan.create({
        data: {
          workspaceId: f.workspaceId,
          createdById: f.accountId,
          sponsorAccountId: f.accountId,
          goal: "LAUNCH_REVIEW",
          mode: "STANDARD",
          accountingVersion: 2,
        },
      })
      await owner.scanCapacityReservation.create({
        data: {
          scanId: next.id,
          accountId: f.accountId,
          userId: f.accountId,
          workspaceId: f.workspaceId,
          multiplier: 1,
        },
      })
      await reserveScanCapacity({
        workspaceId: f.workspaceId,
        scanId: next.id,
        maxRuntimeMs: 300_000,
        start: true,
      })
      expect(
        await owner.scanCapacityReservation.findUniqueOrThrow({ where: { scanId: next.id } })
      ).toMatchObject({ poolMinutes: 5, packMinutes: 0, graceMinutes: 0, overageMinutes: 0 })
    }
  )

  it("projects mixed legacy and v2 funding without rewriting history or double-debiting packs", async () => {
    const f = await fixture(12, 5)
    const { reserveScanCapacity, now } = await enableCapacity(f)
    const old = await insertReceipt(f, {
      quantity: 2,
      cycleStart: now,
      idempotencyKey: `${f.idempotencyKey}:legacy-before`,
      metadata: { historical: true },
    })
    await reserveScanCapacity({
      workspaceId: f.workspaceId,
      scanId: f.scanId,
      maxRuntimeMs: 600_000,
      start: true,
    })
    await reserveScanCapacity({
      workspaceId: f.workspaceIds[1]!,
      scanId: f.scanIds[1]!,
      maxRuntimeMs: 300_000,
      start: true,
    })
    await recordAgentMinutes(f.workspaceIds[1]!, f.scanIds[1]!, 300_000, { phase: "engine_run" })
    await recordAgentMinutes(f.workspaceId, f.scanId, 300_000, { phase: "engine_run" })
    const legacy = await owner.scan.create({
      data: {
        workspaceId: f.workspaceId,
        createdById: f.accountId,
        goal: "LAUNCH_REVIEW",
        mode: "STANDARD",
      },
    })
    expect(
      await recordAgentMinutes(f.workspaceId, legacy.id, 120_000, {
        phase: "engine_run",
        cycleStart: now,
      })
    ).toMatchObject({ minutes: 2, overageMinutes: 0 })
    const { getUsageBalance } = await import("./balance")
    expect(await getUsageBalance(f.accountId)).toMatchObject({
      poolRemaining: 3,
      poolConsumed: 9,
      packConsumed: 5,
    })
    expect(await owner.usageRecord.findUnique({ where: { id: old.id } })).toEqual(old)
  })

  it("Deep uses whole-minute rounding before its multiplier and absorbs stop latency", async () => {
    const f = await fixture(5)
    await owner.billingAccount.updateMany({
      where: { accountId: f.accountId },
      data: { graceUsedMs: 900_000 },
    })
    const { reserveScanCapacity } = await enableCapacity(f, "DEEP")
    expect(
      await reserveScanCapacity({
        scanId: f.scanId,
        workspaceId: f.workspaceId,
        maxRuntimeMs: 120_000,
        start: true,
      })
    ).toMatchObject({ fundedMinutes: 3, runtimeLimitMs: 55_000 })
    const result = await recordAgentMinutes(f.workspaceId, f.scanId, 60_001, {
      phase: "engine_run",
      mode: "DEEP",
      outcome: "partial",
    })
    expect(result.minutes).toBe(3)
    const row = await owner.scanCapacityReservation.findUniqueOrThrow({
      where: { scanId: f.scanId },
    })
    expect(row.absorbedMinutes).toBe(3)
    expect(row.state).toBe("SETTLED")
    const replay = await recordAgentMinutes(f.workspaceId, f.scanId, 60_001, {
      phase: "engine_run",
      mode: "DEEP",
      outcome: "partial",
    })
    expect(replay.created).toBe(false)
    expect((await ledger(f)).usage).toHaveLength(1)
  })

  it("reserves remaining eligible overage without adding grace", async () => {
    const f = await fixture(1)
    const { reserveScanCapacity, now } = await enableCapacity(f)
    await owner.billingAccount.updateMany({
      where: { accountId: f.accountId },
      data: { currentPlan: "LAUNCH_ASSURANCE", spendLimitCents: 45 },
    })
    await owner.usageRecord.create({
      data: {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        kind: "overage_minutes",
        quantity: 2,
        cycleStart: now,
        idempotencyKey: `${f.accountId}:prior-overage`,
      },
    })
    expect(
      await reserveScanCapacity({
        scanId: f.scanId,
        workspaceId: f.workspaceId,
        maxRuntimeMs: 600_000,
        start: true,
      })
    ).toMatchObject({ fundedMinutes: 2, runtimeLimitMs: 115_000 })
    await recordAgentMinutes(f.workspaceId, f.scanId, 115_000, { phase: "engine_run" })
    const row = await owner.scanCapacityReservation.findUniqueOrThrow({
      where: { scanId: f.scanId },
    })
    expect(row.graceMinutes).toBe(0)
    expect(row.overageMinutes).toBe(1)
    const billing = await owner.billingAccount.findFirstOrThrow({
      where: { accountId: f.accountId },
    })
    expect(billing.graceUsedMs).toBe(0)
  })

  it("rolls back reservation settlement if evidence finalization fails, without replaying engine work", async () => {
    const f = await fixture(2, 2)
    const { reserveScanCapacity } = await enableCapacity(f)
    await reserveScanCapacity({
      scanId: f.scanId,
      workspaceId: f.workspaceId,
      maxRuntimeMs: 180_000,
      start: true,
    })
    await expect(
      recordAgentMinutes(f.workspaceId, f.scanId, 180_000, {
        phase: "engine_run",
        beforeCommit: async () => {
          throw new Error("evidence unavailable")
        },
      })
    ).rejects.toThrow("evidence unavailable")
    expect((await ledger(f)).usage).toHaveLength(0)
    expect((await ledger(f)).packs[0]?.remainingMinutes).toBe(2)
    expect(
      (await owner.scanCapacityReservation.findUniqueOrThrow({ where: { scanId: f.scanId } })).state
    ).toBe("RUNNING")
    await expect(
      reserveScanCapacity({
        scanId: f.scanId,
        workspaceId: f.workspaceId,
        maxRuntimeMs: 180_000,
        start: true,
      })
    ).rejects.toThrow("capacity_execution_already_started")
    expect(await hasUnsettledScanIntent(f.workspaceId, f.scanId)).toBe(true)
  })

  it("holds terminal slots until stopped and durably settled; ambiguous commits remain held", async () => {
    const f = await fixture(2)
    const { reserveScanCapacity } = await enableCapacity(f)
    const { confirmScanCapacityStopped } = await import("./capacity")
    await owner.userScanSlot.create({
      data: { userId: f.accountId, scanId: f.scanId, workspaceId: f.workspaceId },
    })
    await reserveScanCapacity({
      scanId: f.scanId,
      workspaceId: f.workspaceId,
      maxRuntimeMs: 120_000,
      start: true,
    })
    await owner.scan.update({ where: { id: f.scanId }, data: { status: "COMPLETED" } })
    expect(await db.releaseStoppedScanSlot(f.workspaceId, f.scanId)).toBe(false)
    await confirmScanCapacityStopped(f.workspaceId, f.scanId)
    expect(
      (await owner.scanCapacityReservation.findUniqueOrThrow({ where: { scanId: f.scanId } })).state
    ).toBe("REVIEW_REQUIRED")
    expect(await db.releaseStoppedScanSlot(f.workspaceId, f.scanId)).toBe(false)
    expect(await owner.userScanSlot.count({ where: { userId: f.accountId } })).toBe(1)
  })

  it("enforces one user slot across workspaces using real shared createScan transactions", async () => {
    const f = await fixture()
    await owner.scan.updateMany({ where: { id: { in: f.scanIds } }, data: { status: "COMPLETED" } })
    const targetIds: string[] = []
    for (const workspaceId of f.workspaceIds) {
      const target = await owner.target.create({
        data: { workspaceId, name: "admission", type: "REPO", repoFullName: "fixture/repo" },
      })
      targetIds.push(target.id)
    }
    const results = await Promise.allSettled(
      f.workspaceIds.map((workspaceId, i) =>
        db.createScan({
          workspaceId,
          targetId: targetIds[i]!,
          createdById: f.accountId,
          mode: "STANDARD",
          goal: "LAUNCH_REVIEW",
        })
      )
    )
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const denied = results.find((r) => r.status === "rejected") as PromiseRejectedResult
    expect(denied.reason.code).toBe("SCAN_ALREADY_ACTIVE")
    expect(await owner.userScanSlot.count({ where: { userId: f.accountId } })).toBe(1)
  })

  it("keeps slot and reservation RLS closed without their owner context", async () => {
    const f = await fixture(2)
    await enableCapacity(f)
    await owner.userScanSlot.create({
      data: { userId: f.accountId, scanId: f.scanId, workspaceId: f.workspaceId },
    })
    const result = await db.withWorkspaceRLS(f.workspaceId, async (tx) => ({
      slots: await tx.userScanSlot.count(),
      reservations: await tx.scanCapacityReservation.count(),
    }))
    expect(result).toEqual({ slots: 0, reservations: 0 })
  })

  it("releases a queued cancellation atomically without freeing a running cancellation", async () => {
    const f = await fixture(2)
    const { reserveScanCapacity } = await enableCapacity(f)
    await owner.userScanSlot.create({
      data: { userId: f.accountId, scanId: f.scanId, workspaceId: f.workspaceId },
    })
    await owner.scan.update({ where: { id: f.scanId }, data: { status: "QUEUED" } })
    await db.cancelScan(f.scanId, f.workspaceId)
    expect(await owner.userScanSlot.count({ where: { userId: f.accountId } })).toBe(0)
    expect(
      (await owner.scanCapacityReservation.findUniqueOrThrow({ where: { scanId: f.scanId } })).state
    ).toBe("RELEASED")
    const scanId = f.scanIds[1]!,
      workspaceId = f.workspaceIds[1]!
    await owner.userScanSlot.create({ data: { userId: f.accountId, scanId, workspaceId } })
    await reserveScanCapacity({ scanId, workspaceId, maxRuntimeMs: 120_000, start: true })
    await db.cancelScan(scanId, workspaceId)
    expect(await owner.userScanSlot.count({ where: { userId: f.accountId } })).toBe(1)
    await recordAgentMinutes(workspaceId, scanId, 20_000, {
      phase: "engine_run",
      outcome: "cancelled",
    })
    const { confirmScanCapacityStopped } = await import("./capacity")
    await confirmScanCapacityStopped(workspaceId, scanId)
    expect(await db.releaseStoppedScanSlot(workspaceId, scanId)).toBe(true)
    expect((await ledger(f)).usage[0]?.quantity).toBe(1)
  })

  it("revalidates expired packs and a new allowance cycle before provider admission", async () => {
    const f = await fixture(1, 2)
    await owner.billingAccount.updateMany({
      where: { accountId: f.accountId },
      data: { graceUsedMs: 900_000 },
    })
    const { reserveScanCapacity } = await enableCapacity(f)
    expect(
      await reserveScanCapacity({
        scanId: f.scanId,
        workspaceId: f.workspaceId,
        maxRuntimeMs: 180_000,
      })
    ).toMatchObject({ fundedMinutes: 3 })
    await owner.minutePack.updateMany({
      where: { accountId: f.accountId },
      data: { expiresAt: new Date(0) },
    })
    const nextCycle = new Date(Date.now() + 1_000)
    await owner.billingAccount.updateMany({
      where: { accountId: f.accountId },
      data: { currentPeriodStart: nextCycle },
    })
    expect(
      await reserveScanCapacity({
        scanId: f.scanId,
        workspaceId: f.workspaceId,
        maxRuntimeMs: 180_000,
        start: true,
      })
    ).toEqual({ state: "WAITING" })
    const row = await owner.scanCapacityReservation.findUniqueOrThrow({
      where: { scanId: f.scanId },
    })
    expect(row.fundedMinutes).toBe(0)
  })

  it.each([
    ["BUDGET_EXCEEDED", "nonbillable", "RELEASED"],
    ["CAPACITY_EXHAUSTED", "settlement_required", "REVIEW_REQUIRED"],
  ] as const)(
    "releases only authoritative nonbilling at a stopped %s outcome",
    async (errorCategory, disposition, expectedState) => {
      const f = await fixture(5)
      const { reserveScanCapacity } = await enableCapacity(f)
      await owner.userScanSlot.create({
        data: { userId: f.accountId, scanId: f.scanId, workspaceId: f.workspaceId },
      })
      await reserveScanCapacity({
        scanId: f.scanId,
        workspaceId: f.workspaceId,
        maxRuntimeMs: 120_000,
        start: true,
      })
      await owner.scan.update({
        where: { id: f.scanId },
        data: { status: "STOPPED_BUDGET", errorCategory },
      })
      const { confirmScanCapacityStopped } = await import("./capacity")
      await confirmScanCapacityStopped(f.workspaceId, f.scanId, false, disposition)
      await db.releaseStoppedScanSlot(f.workspaceId, f.scanId)
      expect(
        await owner.scanCapacityReservation.findUniqueOrThrow({ where: { scanId: f.scanId } })
      ).toMatchObject({ state: expectedState, stoppedAt: expect.any(Date) })
      expect(await owner.userScanSlot.count({ where: { userId: f.accountId } })).toBe(
        disposition === "nonbillable" ? 0 : 1
      )
      expect(
        await reserveScanCapacity({
          scanId: f.scanIds[1]!,
          workspaceId: f.workspaceIds[1]!,
          maxRuntimeMs: 60_000,
          start: true,
        })
      ).toMatchObject({ state: disposition === "nonbillable" ? "RUNNING" : "WAITING" })
      expect((await ledger(f)).usage).toHaveLength(0)
    }
  )

  it("keeps genuine failed and pre-provider work free and releases its stopped capacity", async () => {
    const f = await fixture(2)
    const { reserveScanCapacity } = await enableCapacity(f)
    await reserveScanCapacity({
      scanId: f.scanId,
      workspaceId: f.workspaceId,
      maxRuntimeMs: 120_000,
      start: true,
    })
    await recordAgentMinutes(f.workspaceId, f.scanId, 70_000, {
      phase: "engine_run",
      outcome: "failed",
    })
    await owner.scan.update({ where: { id: f.scanId }, data: { status: "FAILED" } })
    const { confirmScanCapacityStopped } = await import("./capacity")
    await confirmScanCapacityStopped(f.workspaceId, f.scanId)
    expect((await ledger(f)).usage).toHaveLength(0)
    expect(
      (await owner.scanCapacityReservation.findUniqueOrThrow({ where: { scanId: f.scanId } })).state
    ).toBe("RELEASED")
    expect(
      await reserveScanCapacity({
        scanId: f.scanIds[1]!,
        workspaceId: f.workspaceIds[1]!,
        maxRuntimeMs: 120_000,
        start: true,
      })
    ).toMatchObject({ fundedMinutes: 2 })
  })

  it("never unlocks a running scan solely because cancellation or a terminal status was written", async () => {
    const f = await fixture(2)
    const { reserveScanCapacity } = await enableCapacity(f)
    await owner.userScanSlot.create({
      data: { userId: f.accountId, scanId: f.scanId, workspaceId: f.workspaceId },
    })
    await reserveScanCapacity({
      scanId: f.scanId,
      workspaceId: f.workspaceId,
      maxRuntimeMs: 120_000,
      start: true,
    })
    await owner.scan.update({ where: { id: f.scanId }, data: { status: "FAILED" } })
    await db.releaseUnstartedScanSlot(f.workspaceId, f.scanId)
    expect(await db.releaseStoppedScanSlot(f.workspaceId, f.scanId)).toBe(false)
    expect(await owner.userScanSlot.count({ where: { userId: f.accountId } })).toBe(1)
  })

  it.each([
    [0, 15],
    [840_000, 1],
    [840_001, 0],
    [900_000, 0],
    [960_000, 0],
  ])(
    "reserves only whole grace units with %i milliseconds already used",
    async (used, expected) => {
      const f = await fixture()
      const { reserveScanCapacity } = await enableCapacity(f)
      await owner.billingAccount.updateMany({
        where: { accountId: f.accountId },
        data: { graceUsedMs: used },
      })
      const result = await reserveScanCapacity({
        scanId: f.scanId,
        workspaceId: f.workspaceId,
        maxRuntimeMs: 900_000,
        start: true,
      })
      if (expected) expect(result).toMatchObject({ state: "RUNNING", fundedMinutes: expected })
      else expect(result).toEqual({ state: "WAITING" })
    }
  )

  it("retains the v2 slot after a genuine PostgreSQL serialization failure following durable evidence", async () => {
    const f = await fixture(0, 5)
    const { reserveScanCapacity } = await enableCapacity(f)
    await owner.userScanSlot.create({
      data: { userId: f.accountId, scanId: f.scanId, workspaceId: f.workspaceId },
    })
    await reserveScanCapacity({
      scanId: f.scanId,
      workspaceId: f.workspaceId,
      maxRuntimeMs: 180_000,
      start: true,
    })
    const finalize = vi.fn(async () => {
      await owner.$transaction(
        async (tx) => {
          // A real SSI cycle: meter read Scan and writes MinutePack; this
          // independent transaction reads MinutePack and durably writes Scan.
          await tx.minutePack.findMany({ where: { accountId: f.accountId } })
          await tx.scan.update({ where: { id: f.scanId }, data: { status: "PARTIAL" } })
        },
        { isolationLevel: "Serializable" }
      )
    })
    await expect(
      recordAgentMinutes(f.workspaceId, f.scanId, 175_000, {
        phase: "engine_run",
        beforeCommit: finalize,
      })
    ).rejects.toMatchObject({ name: "DriverAdapterError" })
    expect(finalize).toHaveBeenCalledTimes(1)
    expect((await ledger(f)).usage).toHaveLength(0)
    expect((await ledger(f)).packs[0]?.remainingMinutes).toBe(5)
    expect(await hasUnsettledScanIntent(f.workspaceId, f.scanId)).toBe(true)
    const { confirmScanCapacityStopped } = await import("./capacity")
    await confirmScanCapacityStopped(f.workspaceId, f.scanId)
    expect(
      (await owner.scanCapacityReservation.findUniqueOrThrow({ where: { scanId: f.scanId } })).state
    ).toBe("REVIEW_REQUIRED")
    expect(await db.releaseStoppedScanSlot(f.workspaceId, f.scanId)).toBe(false)
  })

  it("keeps deterministic execution in the user slot without blocking account funding FIFO", async () => {
    const f = await fixture()
    await owner.scan.updateMany({ where: { id: { in: f.scanIds } }, data: { status: "COMPLETED" } })
    const target = await owner.target.create({
      data: {
        workspaceId: f.workspaceId,
        name: "surface",
        type: "WEB_APP",
        url: "https://example.test",
      },
    })
    const scan = await db.createScan({
      workspaceId: f.workspaceId,
      targetId: target.id,
      createdById: f.accountId,
      mode: "SAFE",
      goal: "LAUNCH_REVIEW",
    })
    const reservation = await owner.scanCapacityReservation.findUniqueOrThrow({
      where: { scanId: scan.id },
    })
    expect(reservation).toMatchObject({ state: "RESERVED", fundedMinutes: 0 })
    const { startUnmeteredScanCapacity, confirmScanCapacityStopped } = await import("./capacity")
    await startUnmeteredScanCapacity(f.workspaceId, scan.id)
    await db.cancelScan(scan.id, f.workspaceId)
    expect(await owner.userScanSlot.count({ where: { userId: f.accountId } })).toBe(1)
    await confirmScanCapacityStopped(f.workspaceId, scan.id, true)
    expect(await db.releaseStoppedScanSlot(f.workspaceId, scan.id)).toBe(true)
    expect((await ledger(f)).usage).toHaveLength(0)
  })

  it("drops a provisional reservation when another scan requires accounting review before provider start", async () => {
    const f = await fixture(10)
    const { reserveScanCapacity } = await enableCapacity(f)
    expect(
      await reserveScanCapacity({
        scanId: f.scanId,
        workspaceId: f.workspaceId,
        maxRuntimeMs: 180_000,
      })
    ).toMatchObject({ state: "RESERVED", fundedMinutes: 3 })
    await owner.scanCapacityReservation.update({
      where: { scanId: f.scanIds[1] },
      data: { state: "REVIEW_REQUIRED" },
    })
    expect(
      await reserveScanCapacity({
        scanId: f.scanId,
        workspaceId: f.workspaceId,
        maxRuntimeMs: 180_000,
        start: true,
      })
    ).toEqual({ state: "WAITING" })
    expect(
      await owner.scanCapacityReservation.findUniqueOrThrow({ where: { scanId: f.scanId } })
    ).toMatchObject({ state: "WAITING", fundedMinutes: 0, packAllocations: [] })
  })

  it("returns funding to WAITING for a worker-proven pre-provider retry while retaining the user slot", async () => {
    const f = await fixture(5)
    const now = new Date()
    await owner.scan.updateMany({ where: { id: { in: f.scanIds } }, data: { status: "COMPLETED" } })
    await owner.billingAccount.updateMany({
      where: { accountId: f.accountId },
      data: { currentPeriodStart: now },
    })
    await owner.usageRecord.updateMany({
      where: { accountId: f.accountId },
      data: { cycleStart: now },
    })
    const target = await owner.target.create({
      data: {
        workspaceId: f.workspaceId,
        name: "retry",
        type: "REPO",
        repoFullName: "fixture/retry",
      },
    })
    const scan = await db.createScan({
      workspaceId: f.workspaceId,
      targetId: target.id,
      createdById: f.accountId,
      mode: "STANDARD",
      goal: "LAUNCH_REVIEW",
    })
    const { reserveScanCapacity, resetUnstartedScanCapacity } = await import("./capacity")
    await reserveScanCapacity({
      scanId: scan.id,
      workspaceId: f.workspaceId,
      maxRuntimeMs: 120_000,
      start: true,
    })
    await owner.scan.update({ where: { id: scan.id }, data: { startedAt: new Date() } })
    await resetUnstartedScanCapacity(f.workspaceId, scan.id)
    expect((await owner.scan.findUniqueOrThrow({ where: { id: scan.id } })).startedAt).toBeNull()
    expect(
      await owner.scanCapacityReservation.findUniqueOrThrow({ where: { scanId: scan.id } })
    ).toMatchObject({ state: "WAITING", fundedMinutes: 0 })
    expect(await owner.userScanSlot.count({ where: { userId: f.accountId } })).toBe(1)
    expect(
      await reserveScanCapacity({
        scanId: scan.id,
        workspaceId: f.workspaceId,
        maxRuntimeMs: 120_000,
        start: true,
      })
    ).toMatchObject({ state: "RUNNING", fundedMinutes: 2 })
  })

  it("settles concurrent phases across workspaces against one account and retries real serialization contention", async () => {
    const f = await fixture(5, 20)
    const entered = deferred()
    const release = deferred()
    const first = recordAgentMinutes(f.workspaceId, f.scanId, 240_000, {
      phase: "engine_run",
      cycleStart,
      beforeCommit: async () => {
        entered.resolve()
        await release.promise
      },
    })
    await entered.promise
    const second = recordAgentMinutes(f.workspaceIds[1]!, f.scanIds[1]!, 240_000, {
      phase: "engine_run",
      cycleStart,
    })
    try {
      await waitForContendingTransaction()
    } finally {
      release.resolve()
    }
    const results = await Promise.all([first, second])
    expect(results.every((result) => result.created && result.minutes === 4)).toBe(true)
    const state = await ledger(f)
    expect(state.usage).toHaveLength(2)
    expect(state.usage.reduce((sum, row) => sum + row.quantity, 0)).toBe(8)
    expect(state.packs[0]?.remainingMinutes).toBe(17)
    expect(
      coordination.transactionErrors.some(
        (error) => error && typeof error === "object" && "code" in error && error.code === "P2034"
      )
    ).toBe(true)
  })

  it("concurrent identical settlements create one receipt and debit packs once", async () => {
    const f = await fixture(0, 10)
    const results = await Promise.all(
      [0, 1].map(() =>
        recordAgentMinutes(f.workspaceId, f.scanId, 180_000, {
          phase: "engine_run",
          cycleStart,
        })
      )
    )
    expect(results.map((result) => result.created).sort()).toEqual([false, true])
    const state = await ledger(f)
    expect(state.usage).toHaveLength(1)
    expect(state.packs[0]?.remainingMinutes).toBe(7)
  })

  it("recovers a real legacy usage-key conflict only from a fresh durable receipt and preserves overage", async () => {
    const f = await fixture(0, 5)
    coordination.afterReceiptRead = async () => {
      await insertReceipt(f)
    }
    const finalize = vi.fn()
    const result = await recordAgentMinutes(f.workspaceId, f.scanId, 180_000, {
      phase: "engine_run",
      cycleStart,
      beforeCommit: finalize,
    })
    expect(result).toMatchObject({
      created: false,
      minutes: 0,
      accountId: f.accountId,
      overageMinutes: 2,
    })
    expect(finalize).not.toHaveBeenCalled()
    const state = await ledger(f)
    expect(state.usage).toHaveLength(1)
    expect(state.packs[0]?.remainingMinutes).toBe(5) // Losing transaction's provisional debit rolled back.
    const conflicts = coordination.transactionErrors.filter(
      (error) => error instanceof Error && error.message === "agent_minute_usage_receipt_conflict"
    )
    expect(conflicts).toHaveLength(1)
  })

  it.each(["kind", "scan", "workspace", "account", "deleted"] as const)(
    "rejects a real %s receipt mismatch",
    async (mismatch) => {
      const f = await fixture(0, 5)
      const other = mismatch === "account" ? await fixture() : undefined
      await insertReceipt(f, {
        ...(mismatch === "kind" ? { kind: "pool_grant" } : {}),
        ...(mismatch === "scan" ? { metadata: { scanId: "other", accountId: f.accountId } } : {}),
        ...(mismatch === "workspace" ? { workspaceId: f.workspaceIds[1] } : {}),
        ...(mismatch === "account" ? { accountId: other!.accountId } : {}),
        ...(mismatch === "deleted" ? { deletedAt: new Date() } : {}),
      })
      const before = await ledger(f)
      const finalize = vi.fn()
      await expect(
        recordAgentMinutes(f.workspaceId, f.scanId, 180_000, {
          phase: "engine_run",
          cycleStart,
          beforeCommit: finalize,
        })
      ).rejects.toThrow()
      expect(finalize).not.toHaveBeenCalled()
      expect(await ledger(f)).toEqual(before)
    }
  )

  it("does not mask a real finalizer P2002 with an already matching usage receipt", async () => {
    const f = await fixture(0, 5)
    await insertReceipt(f)
    const before = await ledger(f)
    const finalize = vi.fn(async () => {
      // Actual PostgreSQL unique violation, including the same constraint that
      // usage insertion may recover. Origin must still prohibit recovery.
      await insertReceipt(f)
    })
    await expect(
      recordAgentMinutes(f.workspaceId, f.scanId, 180_000, {
        phase: "engine_run",
        cycleStart,
        beforeCommit: finalize,
      })
    ).rejects.toMatchObject({
      code: "P2002",
      meta: {
        modelName: "UsageRecord",
        driverAdapterError: { cause: { constraint: { fields: ['"idempotencyKey"'] } } },
      },
    })
    expect(finalize).toHaveBeenCalledOnce()
    expect(await ledger(f)).toEqual(before)
  })

  it("rolls provisional usage and pack debits back on unrelated overage uniqueness failure", async () => {
    const f = await fixture(0, 1)
    const before = await ledger(f)
    const finalize = vi.fn()
    await expect(
      recordAgentMinutes(f.workspaceId, f.scanId, 180_000, {
        phase: "engine_run",
        cycleStart,
        beforeCommit: finalize,
        settleOverage: async (tx) => {
          await tx.minutePack.create({
            data: {
              accountId: f.accountId,
              workspaceId: f.workspaceId,
              provider: "test",
              externalId: f.accountId,
              minutes: 2,
              remainingMinutes: 2,
            },
          })
        },
      })
    ).rejects.toMatchObject({
      code: "P2002",
      meta: { modelName: "MinutePack", driverAdapterError: { cause: { originalCode: "23505" } } },
    })
    expect(finalize).not.toHaveBeenCalled()
    expect(await ledger(f)).toEqual(before)
    expect(await hasUnsettledScanIntent(f.workspaceId, f.scanId)).toBe(true)
  })

  it("retains independently durable evidence after finalization failure without charging or rerunning it", async () => {
    const f = await fixture(0, 5)
    const before = await ledger(f)
    const finalize = vi.fn(async () => {
      await owner.scanEvent.create({
        data: { scanId: f.scanId, stage: "test_terminal_evidence", message: "durable evidence" },
      })
      await owner.scan.update({ where: { id: f.scanId }, data: { status: "COMPLETED" } })
      // Evidence is durable but the finalizer reports a real independent
      // uniqueness failure. Never hide it or retry to charge later.
      await owner.workspace.create({ data: { name: "conflict", slug: f.workspaceId } })
    })
    await expect(
      recordAgentMinutes(f.workspaceId, f.scanId, 180_000, {
        phase: "engine_run",
        cycleStart,
        beforeCommit: finalize,
      })
    ).rejects.toMatchObject({
      code: "P2002",
      meta: {
        modelName: "Workspace",
        driverAdapterError: { cause: { constraint: { fields: ["slug"] } } },
      },
    })
    expect(finalize).toHaveBeenCalledOnce()
    expect(await ledger(f)).toEqual(before)
    expect((await owner.scan.findUniqueOrThrow({ where: { id: f.scanId } })).status).toBe(
      "COMPLETED"
    )
    expect(
      await owner.scanEvent.count({ where: { scanId: f.scanId, stage: "test_terminal_evidence" } })
    ).toBe(1)
    expect(await hasUnsettledScanIntent(f.workspaceId, f.scanId)).toBe(true)
  })

  it("never retries finalization after a real serialization failure at monetary commit", async () => {
    const f = await fixture(0, 5)
    const before = await ledger(f)
    let finalizerCompleted = false
    const finalize = vi.fn(async () => {
      await owner.scanEvent.create({
        data: {
          scanId: f.scanId,
          stage: "test_terminal_evidence",
          message: "durable before commit",
        },
      })
      await owner.scan.update({ where: { id: f.scanId }, data: { status: "PARTIAL" } })
      // Create a genuine SSI dependency cycle: metering read the grant range
      // and wrote this pack; this competing transaction reads the old pack
      // and writes that grant range, then commits first. PostgreSQL must abort
      // the metering commit after its finalizer has returned successfully.
      await owner.$transaction(
        async (tx) => {
          await tx.minutePack.findMany({ where: { accountId: f.accountId } })
          await tx.usageRecord.create({
            data: {
              accountId: f.accountId,
              workspaceId: f.workspaceId,
              kind: "pool_grant",
              quantity: 1,
              cycleStart,
              idempotencyKey: `${f.accountId}:concurrent-grant`,
            },
          })
        },
        { isolationLevel: "Serializable" }
      )
      finalizerCompleted = true
    })
    await expect(
      recordAgentMinutes(f.workspaceId, f.scanId, 180_000, {
        phase: "engine_run",
        cycleStart,
        beforeCommit: finalize,
      })
    ).rejects.toMatchObject({
      name: "DriverAdapterError",
      cause: { kind: "TransactionWriteConflict", originalCode: "40001" },
    })
    expect(finalizerCompleted).toBe(true)
    expect(finalize).toHaveBeenCalledOnce()
    expect(await ledger(f)).toEqual(before)
    expect((await owner.scan.findUniqueOrThrow({ where: { id: f.scanId } })).status).toBe("PARTIAL")
    expect(
      await owner.scanEvent.count({ where: { scanId: f.scanId, stage: "test_terminal_evidence" } })
    ).toBe(1)
    expect(await hasUnsettledScanIntent(f.workspaceId, f.scanId)).toBe(true)
  })

  it("keeps failed scans unbilled and Deep minute arithmetic exact", async () => {
    const f = await fixture(0, 10)
    const failed = await recordAgentMinutes(f.workspaceId, f.scanId, 65_000, {
      outcome: "failed",
      mode: "DEEP",
    })
    expect(failed).toMatchObject({ created: false, minutes: 0 })
    expect((await ledger(f)).usage).toHaveLength(0)
    const deep = await recordAgentMinutes(f.workspaceId, f.scanId, 65_000, {
      phase: "engine_run",
      cycleStart,
      mode: "DEEP",
    })
    expect(deep).toMatchObject({ created: true, minutes: 6 })
    expect((await ledger(f)).packs[0]?.remainingMinutes).toBe(4)
  })

  it("settles a removed cancellation against its stored sponsor exactly once", async () => {
    const f = await fixture(0, 10)
    const actor = await fixture()
    await owner.scan.update({
      where: { id: f.scanId },
      data: { createdById: actor.accountId, sponsorAccountId: f.accountId },
    })
    await db.cancelScan(f.scanId, f.workspaceId)
    await db.removeScan(f.scanId, f.workspaceId)
    const settle = () =>
      recordAgentMinutes(f.workspaceId, f.scanId, 120_000, {
        phase: "engine_run",
        cycleStart,
        outcome: "cancelled",
      })
    expect(await settle()).toMatchObject({ created: true, minutes: 2, accountId: f.accountId })
    expect(await settle()).toMatchObject({ created: false, minutes: 0, accountId: f.accountId })
    const state = await ledger(f)
    expect(state.usage).toHaveLength(1)
    expect(state.usage[0]).toMatchObject({ accountId: f.accountId, quantity: 2 })
    expect(state.packs[0]?.remainingMinutes).toBe(8)
    expect((await ledger(actor)).usage).toHaveLength(0)
    expect(
      await db.withWorkspaceRLS(f.workspaceId, (tx) =>
        tx.scan.findUnique({ where: { id: f.scanId } })
      )
    ).toBeNull()
  })

  it("recovers a retained settlement intent after cancellation removal", async () => {
    const f = await fixture(0, 10)
    await owner.scanEvent.create({
      data: {
        scanId: f.scanId,
        stage: "billing_settlement_intent",
        message: "disposable settlement fixture",
        metadata: {
          idempotencyKey: f.idempotencyKey,
          accountId: f.accountId,
          workspaceId: f.workspaceId,
        },
      },
    })
    await db.cancelScan(f.scanId, f.workspaceId)
    await db.removeScan(f.scanId, f.workspaceId)
    expect(await hasUnsettledScanIntent(f.workspaceId, f.scanId)).toBe(true)
    await recordAgentMinutes(f.workspaceId, f.scanId, 120_000, {
      phase: "engine_run",
      cycleStart,
      outcome: "cancelled",
    })
    expect(await hasUnsettledScanIntent(f.workspaceId, f.scanId)).toBe(false)
  })

  it("rejects cross-workspace settlement of a removed cancellation", async () => {
    const f = await fixture(0, 10)
    await db.cancelScan(f.scanId, f.workspaceId)
    await db.removeScan(f.scanId, f.workspaceId)
    await expect(
      recordAgentMinutes(f.workspaceIds[1]!, f.scanId, 120_000, {
        phase: "engine_run",
        cycleStart,
        outcome: "cancelled",
      })
    ).rejects.toThrow("settlement_scan_not_found")
    expect(await hasUnsettledScanIntent(f.workspaceIds[1]!, f.scanId)).toBe(false)
    expect((await ledger(f)).usage).toHaveLength(0)
    expect((await ledger(f)).packs[0]?.remainingMinutes).toBe(10)
  })

  it("does not expose another account's receipt through bound runtime reads", async () => {
    const f = await fixture()
    const other = await fixture()
    await insertReceipt(other)
    await db.withWorkspaceRLS(
      f.workspaceId,
      async (tx) => {
        expect(await tx.usageRecord.findMany({ where: { accountId: other.accountId } })).toEqual([])
        expect(await tx.minutePack.findMany({ where: { accountId: other.accountId } })).toEqual([])
      },
      { accountId: f.accountId }
    )
  })
})

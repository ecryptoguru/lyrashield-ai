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

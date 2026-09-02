import { beforeEach, describe, expect, it, vi } from "vitest"

const transactionMock = vi.hoisted(() => vi.fn())
const executeRawMock = vi.hoisted(() => vi.fn().mockResolvedValue(1))
const intentCreateMock = vi.hoisted(() => vi.fn().mockResolvedValue({}))

vi.mock("@lyrashield/db", () => ({
  prisma: { $transaction: transactionMock },
  withWorkspaceRLS: (_workspaceId: string, callback: unknown, options: unknown) =>
    transactionMock(callback, options),
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("@lyrashield/pricing", () => ({ DEEP_SCAN_MULTIPLIER: 3 }))

import { recordAgentMinutes } from "./meter"

interface UsageRecordState {
  id: string
  workspaceId: string
  kind: string
  quantity: number
  idempotencyKey: string
  cycleStart: Date | null
  deletedAt: Date | null
  metadata?: Record<string, unknown>
}

interface PackState {
  id: string
  workspaceId: string
  remainingMinutes: number
  purchasedAt: Date
  expiresAt: Date | null
  deletedAt: Date | null
}

const cycleStart = new Date("2026-08-01T00:00:00.000Z")
let usageRecords: UsageRecordState[]
let packs: PackState[]
let updateManyMock: ReturnType<typeof vi.fn>

function configureDatabase(poolMinutes: number, packMinutes: number[] = []): void {
  usageRecords = poolMinutes
    ? [
        {
          id: "grant_1",
          workspaceId: "ws_1",
          kind: "pool_grant",
          quantity: poolMinutes,
          idempotencyKey: "grant",
          cycleStart,
          deletedAt: null,
        },
      ]
    : []
  packs = packMinutes.map((remainingMinutes, index) => ({
    id: `pack_${index + 1}`,
    workspaceId: "ws_1",
    remainingMinutes,
    purchasedAt: new Date(`2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
    expiresAt: null,
    deletedAt: null,
  }))

  updateManyMock = vi.fn(async ({ where, data }) => {
    const pack = packs.find(
      (candidate) =>
        candidate.id === where.id &&
        candidate.workspaceId === where.workspaceId &&
        candidate.deletedAt === null &&
        candidate.remainingMinutes >= where.remainingMinutes.gte
    )
    if (!pack) return { count: 0 }
    pack.remainingMinutes -= data.remainingMinutes.decrement
    return { count: 1 }
  })

  const tx = {
    scan: { findFirst: vi.fn().mockResolvedValue({ id: "finished" }) },
    scanEvent: { create: intentCreateMock },
    $executeRaw: executeRawMock,
    billingAccount: {
      findUnique: vi.fn().mockResolvedValue({ currentPeriodStart: cycleStart }),
    },
    usageRecord: {
      findUnique: vi.fn(async ({ where }) =>
        usageRecords.find((record) => record.idempotencyKey === where.idempotencyKey)
      ),
      findMany: vi.fn(async ({ where }) => {
        const kinds = Array.isArray(where.kind?.in) ? where.kind.in : [where.kind]
        return usageRecords
          .filter(
            (record) =>
              record.workspaceId === where.workspaceId &&
              kinds.includes(record.kind) &&
              record.deletedAt === null &&
              record.cycleStart !== null &&
              record.cycleStart >= where.cycleStart.gte
          )
          .map(({ quantity }) => ({ quantity }))
      }),
      create: vi.fn(async ({ data }) => {
        usageRecords.push({
          id: `usage_${usageRecords.length + 1}`,
          workspaceId: data.workspaceId,
          kind: data.kind,
          quantity: data.quantity,
          idempotencyKey: data.idempotencyKey,
          cycleStart: data.cycleStart,
          deletedAt: null,
          metadata: data.metadata,
        })
        return {}
      }),
    },
    minutePack: {
      findMany: vi.fn(async () =>
        packs
          .filter((pack) => pack.deletedAt === null && pack.remainingMinutes > 0)
          .sort((left, right) => left.purchasedAt.getTime() - right.purchasedAt.getTime())
          .map(({ id, remainingMinutes }) => ({ id, remainingMinutes }))
      ),
      updateMany: updateManyMock,
    },
  }

  let transactionQueue = Promise.resolve()
  transactionMock.mockImplementation((callback, options) => {
    const result = transactionQueue.then(() => callback(tx))
    transactionQueue = result.then(
      () => undefined,
      () => undefined
    )
    if (options)
      expect(options).toEqual(expect.objectContaining({ isolationLevel: "Serializable" }))
    return result
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("recordAgentMinutes pack debits", () => {
  it("fails before finalization or debit when durable intent insertion fails once", async () => {
    configureDatabase(100, [10])
    const before = structuredClone({ usageRecords, packs })
    const finalize = vi.fn()
    intentCreateMock.mockRejectedValueOnce(new Error("intent insert unavailable"))
    await expect(
      recordAgentMinutes("ws_1", "finished", 60_000, { beforeCommit: finalize })
    ).rejects.toThrow("intent insert unavailable")
    expect(finalize).not.toHaveBeenCalled()
    expect({ usageRecords, packs }).toEqual(before)
    expect(transactionMock).toHaveBeenCalledOnce()
    expect(executeRawMock).not.toHaveBeenCalled()
  })
  it("does not reassess quota after terminal finalization and an uncertain serialization commit", async () => {
    configureDatabase(100)
    const transaction = transactionMock.getMockImplementation()!
    transactionMock.mockImplementation(async (callback, options) => {
      await transaction(callback, options)
      if (options?.isolationLevel)
        throw Object.assign(new Error("commit conflicted"), { code: "P2034" })
    })
    const finish = vi.fn(async () => {})
    await expect(
      recordAgentMinutes("ws_1", "finished", 60_000, { beforeCommit: finish })
    ).rejects.toMatchObject({ code: "P2034" })
    expect(finish).toHaveBeenCalledOnce()
    expect(transactionMock).toHaveBeenCalledTimes(2)
  })
  it.each(["completed", "partial", "cancelled", "failed"] as const)(
    "meters %s according to terminal policy",
    async (outcome) => {
      configureDatabase(100)
      const result = await recordAgentMinutes("ws_1", "scan_outcome", 65_000, { outcome })
      expect(result.minutes).toBe(outcome === "failed" ? 0 : 2)
      expect(usageRecords.filter((r) => r.kind === "agent_minutes")).toHaveLength(
        outcome === "failed" ? 0 : 1
      )
    }
  )
  it("does not force a minute onto a zero-duration partial run", async () => {
    configureDatabase(100)
    expect((await recordAgentMinutes("ws_1", "partial", 0, { outcome: "partial" })).minutes).toBe(0)
    expect(transactionMock).not.toHaveBeenCalled()
  })
  it("debits only each tick's incremental spillover", async () => {
    configureDatabase(10, [20])

    await recordAgentMinutes("ws_1", "scan_1", 8 * 60_000, {
      phase: "tick_1",
      cycleStart,
    })
    await recordAgentMinutes("ws_1", "scan_1", 5 * 60_000, {
      phase: "tick_2",
      cycleStart,
    })
    await recordAgentMinutes("ws_1", "scan_1", 2 * 60_000, {
      phase: "tick_3",
      cycleStart,
    })

    expect(packs[0]?.remainingMinutes).toBe(15)
    expect(updateManyMock.mock.calls.map(([call]) => call.data.remainingMinutes.decrement)).toEqual(
      [3, 2]
    )
  })

  it("debits packs oldest-first", async () => {
    configureDatabase(0, [2, 4])

    await recordAgentMinutes("ws_1", "scan_1", 5 * 60_000, {
      phase: "tick_1",
      cycleStart,
    })

    expect(packs.map((pack) => pack.remainingMinutes)).toEqual([0, 1])
  })

  it("returns only the incremental minutes left uncovered after packs", async () => {
    configureDatabase(4, [2])

    const result = await recordAgentMinutes("ws_1", "scan_1", 3 * 60_000, {
      phase: "tick_1",
      cycleStart,
      mode: "DEEP",
    })

    expect(result).toMatchObject({ created: true, minutes: 9, overageMinutes: 3 })
    expect(packs[0]?.remainingMinutes).toBe(0)
  })

  it("serializes concurrent ticks without over-debiting packs", async () => {
    configureDatabase(5, [20])

    const results = await Promise.all([
      recordAgentMinutes("ws_1", "scan_1", 4 * 60_000, { phase: "tick_1", cycleStart }),
      recordAgentMinutes("ws_1", "scan_1", 4 * 60_000, { phase: "tick_2", cycleStart }),
    ])

    expect(results.every((result) => result.created)).toBe(true)
    expect(packs[0]?.remainingMinutes).toBe(17)
    expect(executeRawMock).toHaveBeenCalledTimes(2)
  })

  it("treats a concurrent idempotent replay as a no-op", async () => {
    configureDatabase(0, [20])

    const results = await Promise.all([
      recordAgentMinutes("ws_1", "scan_1", 3 * 60_000, { phase: "tick_1", cycleStart }),
      recordAgentMinutes("ws_1", "scan_1", 3 * 60_000, { phase: "tick_1", cycleStart }),
    ])

    expect(results.map((result) => result.created).sort()).toEqual([false, true])
    expect(packs[0]?.remainingMinutes).toBe(17)
    expect(updateManyMock).toHaveBeenCalledTimes(1)
  })

  it("restores uncovered minutes on an idempotent replay after a crash", async () => {
    configureDatabase(0, [1])

    const first = await recordAgentMinutes("ws_1", "scan_1", 3 * 60_000, {
      phase: "engine_run",
      cycleStart,
    })
    const replay = await recordAgentMinutes("ws_1", "scan_1", 3 * 60_000, {
      phase: "engine_run",
      cycleStart,
    })

    expect(first.overageMinutes).toBe(2)
    expect(replay).toMatchObject({ created: false, minutes: 0, overageMinutes: 2 })
    expect(packs[0]?.remainingMinutes).toBe(0)
    expect(updateManyMock).toHaveBeenCalledTimes(1)
  })

  it("retries a serializable transaction conflict", async () => {
    configureDatabase(0, [20])
    transactionMock.mockRejectedValueOnce({ code: "P2034" })

    const result = await recordAgentMinutes("ws_1", "scan_1", 3 * 60_000, {
      phase: "tick_1",
      cycleStart,
    })

    expect(result.created).toBe(true)
    expect(transactionMock).toHaveBeenCalledTimes(2)
    expect(packs[0]?.remainingMinutes).toBe(17)
  })
})

describe("recordAgentMinutes billing-outcome rules (founder-confirmed 2026-08-29)", () => {
  it("never bills a failed scan, regardless of elapsed time", async () => {
    configureDatabase(600)
    const result = await recordAgentMinutes("ws_1", "scan_fail", 15 * 60_000, {
      phase: "engine_run",
      cycleStart,
      outcome: "failed",
    })

    expect(result).toMatchObject({ created: false, minutes: 0, overageMinutes: 0 })
    // No UsageRecord written and no transaction opened.
    expect(usageRecords.filter((r) => r.kind === "agent_minutes")).toHaveLength(0)
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("applies the 1-minute floor to a completed scan", async () => {
    configureDatabase(600)
    const result = await recordAgentMinutes("ws_1", "scan_done", 20_000, {
      phase: "engine_run",
      cycleStart,
      outcome: "completed",
    })

    expect(result.created).toBe(true)
    expect(result.minutes).toBe(1) // floor: 20s rounds up to a full minute
  })

  it("bills a cancelled scan at elapsed ceiling WITHOUT forcing value via the floor", async () => {
    configureDatabase(600)
    // 3 minutes 20 seconds elapsed -> ceil = 4 whole minutes, no separate floor.
    const result = await recordAgentMinutes("ws_1", "scan_cancel", 3 * 60_000 + 20_000, {
      phase: "engine_run",
      cycleStart,
      outcome: "cancelled",
    })

    expect(result.created).toBe(true)
    expect(result.minutes).toBe(4)
  })

  it("bills a cancelled scan 0 when no time elapsed", async () => {
    configureDatabase(600)
    const result = await recordAgentMinutes("ws_1", "scan_cancel_zero", 0, {
      phase: "engine_run",
      cycleStart,
      outcome: "cancelled",
    })

    expect(result).toMatchObject({ created: false, minutes: 0, overageMinutes: 0 })
    expect(transactionMock).not.toHaveBeenCalled()
  })
})

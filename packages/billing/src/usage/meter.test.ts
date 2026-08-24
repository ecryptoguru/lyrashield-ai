import { beforeEach, describe, expect, it, vi } from "vitest"

const transactionMock = vi.hoisted(() => vi.fn())
const executeRawMock = vi.hoisted(() => vi.fn().mockResolvedValue(1))

vi.mock("@lyrashield/db", () => ({
  prisma: { $transaction: transactionMock },
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
    expect(options).toEqual({ isolationLevel: "Serializable" })
    return result
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("recordAgentMinutes pack debits", () => {
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

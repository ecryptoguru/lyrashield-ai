import { beforeEach, describe, expect, it, vi } from "vitest"

const billingFindMany = vi.hoisted(() => vi.fn())
const workspaceFindMany = vi.hoisted(() => vi.fn())
const memberFindFirst = vi.hoisted(() => vi.fn())
const grantMonthlyPoolMock = vi.hoisted(() => vi.fn())

vi.mock("@lyrashield/db", () => ({
  getSystemPrisma: () => ({
    billingAccount: { findMany: billingFindMany },
    workspace: { findMany: workspaceFindMany },
    workspaceMember: { findFirst: memberFindFirst },
  }),
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("@lyrashield/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/billing")>()
  return {
    ...actual,
    grantMonthlyPool: (...args: unknown[]) => grantMonthlyPoolMock(...args),
  }
})

import { replenishAllowanceCycles } from "./billing-allowance-replenishment.job"

const termStart = new Date("2026-01-15T10:00:00.000Z")
const termEnd = new Date("2027-01-15T10:00:00.000Z")

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "ba_1",
    accountId: "acct_1",
    workspaceId: "ws_1",
    purchaseWorkspaceId: "ws_1",
    status: "active",
    currentPlan: "PRO",
    interval: "annual",
    currentPeriodStart: termStart,
    currentPeriodEnd: termEnd,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  workspaceFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.map((id) => ({ id }))
  )
  memberFindFirst.mockResolvedValue({ workspaceId: "ws_1" })
  grantMonthlyPoolMock.mockResolvedValue({ created: true, minutes: 1200 })
})

describe("replenishAllowanceCycles", () => {
  it("grants the current monthly cycle for an entitled annual account", async () => {
    billingFindMany.mockResolvedValue([row()])

    const result = await replenishAllowanceCycles()

    expect(result).toEqual({ evaluated: 1, granted: 1, skipped: 0 })
    expect(grantMonthlyPoolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct_1",
        workspaceId: "ws_1",
        plan: "PRO",
        source: "annual_monthly",
      })
    )
    const { cycleStart } = grantMonthlyPoolMock.mock.calls[0]![0] as { cycleStart: Date }
    // Cycle start lands on the monthly anniversary containing `now`.
    expect(cycleStart.getUTCDate()).toBe(15)
    expect(cycleStart.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it("skips rows without account ownership or a payable plan", async () => {
    billingFindMany.mockResolvedValue([
      row({ id: "ba_legacy", accountId: null }),
      row({ id: "ba_free", currentPlan: "FREE" }),
    ])

    const result = await replenishAllowanceCycles()

    expect(result).toEqual({ evaluated: 2, granted: 0, skipped: 2 })
    expect(grantMonthlyPoolMock).not.toHaveBeenCalled()
  })

  it("never grants past the paid term end", async () => {
    billingFindMany.mockResolvedValue([
      row({ status: "canceled", currentPeriodEnd: new Date(Date.now() - 60_000) }),
    ])
    // The SQL prefilter would exclude this row; assert the guard anyway.

    const result = await replenishAllowanceCycles()

    expect(result.granted).toBe(0)
    expect(grantMonthlyPoolMock).not.toHaveBeenCalled()
  })

  it("attributes the grant to a live workspace when the recorded one was deleted", async () => {
    billingFindMany.mockResolvedValue([row()])
    workspaceFindMany.mockResolvedValue([]) // ws_1 deleted
    memberFindFirst.mockResolvedValue({ workspaceId: "ws_member" })

    const result = await replenishAllowanceCycles()

    expect(result.granted).toBe(1)
    expect(grantMonthlyPoolMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_member" })
    )
  })

  it("grants account-only when no live workspace attribution exists", async () => {
    billingFindMany.mockResolvedValue([row()])
    workspaceFindMany.mockResolvedValue([])
    memberFindFirst.mockResolvedValue(null)

    const result = await replenishAllowanceCycles()

    expect(result).toEqual({ evaluated: 1, granted: 1, skipped: 0 })
    expect(grantMonthlyPoolMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: null })
    )
  })

  it("contains a per-row failure so the sweep continues", async () => {
    billingFindMany.mockResolvedValue([row(), row({ id: "ba_2", accountId: "acct_2" })])
    grantMonthlyPoolMock
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValueOnce({ created: true, minutes: 1200 })

    const result = await replenishAllowanceCycles()

    expect(result).toEqual({ evaluated: 2, granted: 1, skipped: 1 })
  })

  it("counts idempotent replays as evaluated, not granted", async () => {
    billingFindMany.mockResolvedValue([row()])
    grantMonthlyPoolMock.mockResolvedValue({ created: false, minutes: 1200 })

    const result = await replenishAllowanceCycles()

    expect(result).toEqual({ evaluated: 1, granted: 0, skipped: 0 })
  })
})

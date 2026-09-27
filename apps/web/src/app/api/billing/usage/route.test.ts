import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getUsageBalance: vi.fn(),
  getAccountTrialState: vi.fn(),
  getGraceState: vi.fn(),
  resolveAccountBilling: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { billing: { manage: "billing:manage" } } }))
vi.mock("@lyrashield/billing", () => ({
  getUsageBalance: mocks.getUsageBalance,
  getAccountTrialState: mocks.getAccountTrialState,
  getGraceState: mocks.getGraceState,
  resolveAccountBilling: mocks.resolveAccountBilling,
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: mocks.loggerError } }))

import { GET } from "./route"

const expiredTrial = {
  isActive: false,
  isExpired: true,
  startedAt: new Date("2026-09-01T00:00:00Z"),
  endsAt: new Date("2026-09-08T00:00:00Z"),
  daysLeft: 0,
  minutesLeft: 37,
  targetsUsed: 1,
  targetCap: 3,
}

function balance(totalRemaining: number) {
  return {
    poolMinutes: 60,
    poolConsumed: 40,
    poolRemaining: 20,
    packRemaining: totalRemaining - 20,
    totalRemaining,
    packs: [],
  }
}

describe("GET /api/billing/usage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({ session: { userId: "account-1" } })
    mocks.getUsageBalance.mockResolvedValue(balance(20))
    mocks.getAccountTrialState.mockResolvedValue(expiredTrial)
    mocks.getGraceState.mockResolvedValue({
      inGrace: false,
      usedMs: 0,
      remainingMs: 0,
      exceeded: false,
    })
    mocks.resolveAccountBilling.mockResolvedValue({
      currentPlan: "FREE",
      status: "free",
      effectivePlan: "FREE",
      interval: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
    })
  })

  it("reports zero expired FREE trial minutes while retaining purchased balance", async () => {
    const response = await GET(
      new Request("https://app.lyrashieldai.com/api/billing/usage?workspaceId=ws-1")
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.trial.minutesLeft).toBe(0)
    expect(body.data.usage.totalRemaining).toBe(20)
    expect(body.data.usage.poolRemaining).toBe(20)
  })

  it("leaves paid account balances intact when a historical trial is expired", async () => {
    mocks.resolveAccountBilling.mockResolvedValue({
      currentPlan: "PRO",
      status: "active",
      effectivePlan: "PRO",
      interval: "monthly",
      currentPeriodStart: null,
      currentPeriodEnd: null,
    })
    mocks.getUsageBalance.mockResolvedValue(balance(80))

    const response = await GET(
      new Request("https://app.lyrashieldai.com/api/billing/usage?workspaceId=ws-1")
    )
    const body = await response.json()

    expect(body.data.trial.minutesLeft).toBe(37)
    expect(body.data.usage.totalRemaining).toBe(80)
  })

  it("reports no usable trial minutes after a paid term lapses", async () => {
    mocks.resolveAccountBilling.mockResolvedValue({
      currentPlan: "PRO",
      status: "canceled",
      effectivePlan: "FREE",
      interval: "monthly",
      currentPeriodStart: null,
      currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
    })

    const response = await GET(
      new Request("https://app.lyrashieldai.com/api/billing/usage?workspaceId=ws-1")
    )
    const body = await response.json()

    expect(body.data.trial.minutesLeft).toBe(0)
    expect(body.data.usage.totalRemaining).toBe(20)
  })
})

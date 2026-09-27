import { renderToString } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  getCachedSession,
  getCachedWorkspaceId,
  findUnique,
  getUsageBalance,
  getAccountTrialState,
  getGraceState,
  isTrialAvailable,
  resolveAccountBilling,
  resolveWorkspaceScanSponsor,
} = vi.hoisted(() => ({
  getCachedSession: vi.fn(),
  getCachedWorkspaceId: vi.fn(),
  findUnique: vi.fn(),
  getUsageBalance: vi.fn(),
  getAccountTrialState: vi.fn(),
  getGraceState: vi.fn(),
  isTrialAvailable: vi.fn(),
  resolveAccountBilling: vi.fn(),
  resolveWorkspaceScanSponsor: vi.fn(),
}))

vi.mock("@/lib/cache", () => ({
  getCachedSession: (...args: unknown[]) => getCachedSession(...args),
  getCachedWorkspaceId: (...args: unknown[]) => getCachedWorkspaceId(...args),
}))
vi.mock("@lyrashield/db", () => ({
  prisma: { workspaceMember: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}))
vi.mock("@lyrashield/auth", () => ({
  hasPermission: () => true,
  PERMISSIONS: { billing: { manage: "billing:manage" } },
}))
vi.mock("@lyrashield/billing", () => ({
  getUsageBalance: (...args: unknown[]) => getUsageBalance(...args),
  getAccountTrialState: (...args: unknown[]) => getAccountTrialState(...args),
  getGraceState: (...args: unknown[]) => getGraceState(...args),
  isTrialAvailable: (...args: unknown[]) => isTrialAvailable(...args),
  resolveAccountBilling: (...args: unknown[]) => resolveAccountBilling(...args),
  resolveWorkspaceScanSponsor: (...args: unknown[]) => resolveWorkspaceScanSponsor(...args),
  // Mirror the real catalog shape: only the purchasable cloud plan ids have
  // entries, so FREE and TEAM fall through to the plan token.
  CLOUD_PLAN_MAP: {
    TRIAL: { name: "Trial" },
    STARTER: { name: "Starter" },
    PRO: { name: "Pro" },
    LAUNCH_ASSURANCE: { name: "Agency" },
    ENTERPRISE: { name: "Enterprise" },
  },
}))
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}))
vi.mock("@/lib/billing-admission", () => ({
  resolveRequestBillingProvider: () => ({ provider: "polar" }),
  getRequestBillingAdmission: () => ({ allowed: true }),
}))
vi.mock("./billing-actions", () => ({ BillingActions: () => null }))
vi.mock("./buy-pack-button", () => ({ BuyPackButton: () => null }))
vi.mock("./upgrade-now-button", () => ({ UpgradeNowButton: () => null }))
vi.mock("./spend-limit-form", () => ({ SpendLimitForm: () => null }))
vi.mock("./billing-return-notice", () => ({ BillingReturnNotice: () => null }))

import BillingPage from "./page"

const inactiveTrial = {
  isActive: false,
  isExpired: false,
  daysLeft: 0,
  minutesLeft: 0,
  targetsUsed: 0,
  targetCap: 0,
}

function mockPlan(currentPlan: string) {
  resolveAccountBilling.mockResolvedValue({
    currentPlan,
    effectivePlan: currentPlan,
    provider: "polar",
    status: "active",
    interval: null,
    currentPeriodEnd: null,
    canceledAt: null,
    spendLimitCents: null,
  })
}

describe("billing page plan label", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCachedSession.mockResolvedValue({ userId: "user-1" })
    getCachedWorkspaceId.mockResolvedValue("workspace-1")
    findUnique.mockResolvedValue({ role: "OWNER" })
    getUsageBalance.mockResolvedValue({
      poolConsumed: 0,
      poolMinutes: 0,
      packRemaining: 0,
      totalRemaining: 0,
      packs: [],
    })
    getAccountTrialState.mockResolvedValue(inactiveTrial)
    getGraceState.mockResolvedValue({ inGrace: false, remainingMs: 0 })
    isTrialAvailable.mockResolvedValue(false)
    resolveWorkspaceScanSponsor.mockResolvedValue(null)
  })

  it("labels a FREE plan as Free, not the raw token", async () => {
    mockPlan("FREE")

    const html = renderToString(await BillingPage({ searchParams: Promise.resolve({}) }))

    expect(html).toContain(">Free</p>")
    expect(html).not.toContain(">FREE</p>")
  })

  it("labels a TEAM plan as Team, not the raw token", async () => {
    mockPlan("TEAM")

    const html = renderToString(await BillingPage({ searchParams: Promise.resolve({}) }))

    expect(html).toContain(">Team</p>")
    expect(html).not.toContain(">TEAM</p>")
  })

  it("shows the signed-in account's available minutes beside its plan", async () => {
    mockPlan("PRO")
    getUsageBalance.mockResolvedValue({
      poolConsumed: 20,
      poolMinutes: 100,
      packRemaining: 15,
      totalRemaining: 95,
      packs: [],
    })

    const html = renderToString(await BillingPage({ searchParams: Promise.resolve({}) }))

    expect(html).toContain("Your account balance:")
    expect(html).toContain("95")
    expect(html).toContain("agent-minutes available")
    expect(html).toContain(">Pro</p>")
    expect(html).toContain("Minutes, plan access and billing status belong to your account.")
  })

  it("forfeits expired FREE trial minutes without hiding purchased pack balance", async () => {
    mockPlan("FREE")
    getAccountTrialState.mockResolvedValue({ ...inactiveTrial, isExpired: true, minutesLeft: 37 })
    getUsageBalance.mockResolvedValue({
      poolConsumed: 9,
      poolMinutes: 60,
      packRemaining: 12,
      totalRemaining: 63,
      packs: [{ remainingMinutes: 12, expiresAt: null, purchasedAt: new Date("2026-09-01") }],
    })

    const html = renderToString(await BillingPage({ searchParams: Promise.resolve({}) }))

    expect(html).toContain("Unused trial minutes were forfeited.")
    expect(html).toContain("9<!-- --> used of<!-- --> <!-- -->60")
    expect(html).toContain("0<!-- --> agent-minutes available")
    expect(html).toContain('Pack Minutes</p><p class="text-xl font-semibold">12</p>')
    expect(html).toContain('Total Remaining</p><p class="text-xl font-semibold">0</p>')
    expect(html).not.toContain("63<!-- --> agent-minutes available")
    expect(html).toContain('Minutes Left</p><p class="text-xl font-semibold">0')
  })

  it("preserves a paid account's pool balance when its historical trial is expired", async () => {
    mockPlan("PRO")
    getAccountTrialState.mockResolvedValue({ ...inactiveTrial, isExpired: true, minutesLeft: 37 })
    getUsageBalance.mockResolvedValue({
      poolConsumed: 20,
      poolMinutes: 100,
      packRemaining: 0,
      totalRemaining: 80,
      packs: [],
    })

    const html = renderToString(await BillingPage({ searchParams: Promise.resolve({}) }))

    expect(html).toContain("80<!-- --> agent-minutes available")
    expect(html).not.toContain("Unused trial minutes were forfeited.")
  })

  it("does not show retained balance as spendable after a paid term lapses", async () => {
    mockPlan("PRO")
    resolveAccountBilling.mockResolvedValue({
      currentPlan: "PRO",
      effectivePlan: "FREE",
      provider: "polar",
      status: "canceled",
      interval: "monthly",
      currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
      canceledAt: new Date("2026-08-01T00:00:00Z"),
      spendLimitCents: null,
    })
    getAccountTrialState.mockResolvedValue({ ...inactiveTrial, isExpired: true, minutesLeft: 37 })
    getUsageBalance.mockResolvedValue({
      poolConsumed: 9,
      poolMinutes: 60,
      packRemaining: 12,
      totalRemaining: 63,
      packs: [{ remainingMinutes: 12, expiresAt: null, purchasedAt: new Date("2026-09-01") }],
    })

    const html = renderToString(await BillingPage({ searchParams: Promise.resolve({}) }))

    expect(html).toContain("Your trial has expired.")
    expect(html).toContain("0<!-- --> agent-minutes available")
    expect(html).toContain('Pack Minutes</p><p class="text-xl font-semibold">12</p>')
    expect(html).toContain('Total Remaining</p><p class="text-xl font-semibold">0</p>')
  })

  it("formats large minute counts and uses singular day wording", async () => {
    mockPlan("FREE")
    getAccountTrialState.mockResolvedValue({
      ...inactiveTrial,
      isActive: true,
      daysLeft: 1,
      minutesLeft: 4_500,
    })
    getUsageBalance.mockResolvedValue({
      poolConsumed: 1_234,
      poolMinutes: 4_500,
      packRemaining: 0,
      totalRemaining: 3_266,
      packs: [],
    })

    const html = renderToString(await BillingPage({ searchParams: Promise.resolve({}) }))

    expect(html).toContain("3,266<!-- --> agent-minutes available")
    expect(html).toContain("Trial active · 1 day and 4,500 minutes remaining.")
    expect(html).toContain("1,234<!-- --> used of<!-- --> <!-- -->4,500")
    expect(html).not.toContain("1 days")
  })
})

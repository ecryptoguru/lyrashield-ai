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
})

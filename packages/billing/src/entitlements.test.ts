import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock dependencies so entitlement checks only need prisma.workspace.findUnique.
vi.mock("@lyrashield/db", () => ({
  prisma: {
    workspace: {
      findUnique: vi.fn(),
    },
    target: {
      count: vi.fn(),
    },
    usageRecord: {
      aggregate: vi.fn(),
    },
  },
}))

vi.mock("@lyrashield/pricing", () => ({
  CLOUD_PLAN_MAP: {
    FREE: { id: "FREE", deepAllowed: false, agentMinutes: 0, targetCaps: 3 },
    TRIAL: { id: "TRIAL", deepAllowed: false, agentMinutes: 100, targetCaps: 3 },
    STARTER: { id: "STARTER", deepAllowed: false, agentMinutes: 300, targetCaps: 5 },
    PRO: { id: "PRO", deepAllowed: true, agentMinutes: 1200, targetCaps: 15 },
    LAUNCH_ASSURANCE: {
      id: "LAUNCH_ASSURANCE",
      deepAllowed: true,
      agentMinutes: 6000,
      targetCaps: 50,
    },
    ENTERPRISE: { id: "ENTERPRISE", deepAllowed: true, agentMinutes: 0, targetCaps: 0 },
  },
  STANDARD_OVERAGE_PER_MINUTE_USD: 0.15,
}))

// Mock the account/usage/trial/grace modules so plan gating is exercised in
// isolation without a full DB balance/trial computation.
vi.mock("./account", () => ({
  resolveAccountBilling: vi.fn(),
}))

vi.mock("./usage/balance", () => ({
  getUsageBalance: vi.fn(),
  getUsageBalanceForTx: vi.fn(),
  resolveBalanceCycleStart: vi.fn(),
}))

vi.mock("./trial", () => ({
  getAccountTrialState: vi.fn().mockResolvedValue({ isExpired: false, isActive: false }),
  blockOnExpiry: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("./grace", () => ({
  getGraceState: vi.fn().mockResolvedValue({ inGrace: false }),
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { assertScanAllowed, assertTargetAllowed } from "./entitlements"
import { prisma } from "@lyrashield/db"
import { resolveAccountBilling } from "./account"
import { getUsageBalance } from "./usage/balance"
import { getAccountTrialState } from "./trial"

function billing(plan: string, extra: Record<string, unknown> = {}) {
  return {
    id: "ba_1",
    accountId: "acct_1",
    workspaceId: "ws_1",
    purchaseWorkspaceId: "ws_1",
    provider: "polar",
    externalId: "sub_1",
    status: "active",
    currentPlan: plan,
    effectivePlan: plan,
    interval: "monthly",
    currentPeriodStart: new Date("2026-09-01T00:00:00Z"),
    currentPeriodEnd: null,
    canceledAt: null,
    trialEndsAt: null,
    spendLimitCents: null,
    graceUsedMs: 0,
    graceCycleStart: null,
    ...extra,
  }
}

describe("entitlements — Deep scan gating on the sponsoring account (Deep = Pro+)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({ id: "ws_1" } as never)
    // Default: account trial not expired, plenty of minutes.
    vi.mocked(getAccountTrialState).mockResolvedValue({
      isActive: false,
      isExpired: false,
      startedAt: null,
      endsAt: null,
      daysLeft: 0,
      minutesLeft: 0,
      targetsUsed: 0,
      targetCap: 3,
    })
    vi.mocked(getUsageBalance).mockResolvedValue({ totalRemaining: 600 } as never)
  })

  it("blocks DEEP on a STARTER account (deepAllowed=false)", async () => {
    vi.mocked(resolveAccountBilling).mockResolvedValue(billing("STARTER") as never)

    const result = await assertScanAllowed("ws-starter", "DEEP", "acct_1")

    expect(result.allowed).toBe(false)
    expect(result.code).toBe("DEEP_NOT_ALLOWED")
    expect(result.isTrial).toBe(false)
  })

  it("blocks DEEP on a TRIAL account (FREE + active trial)", async () => {
    vi.mocked(resolveAccountBilling).mockResolvedValue(billing("FREE") as never)
    vi.mocked(getAccountTrialState).mockResolvedValue({
      isActive: true,
      isExpired: false,
      startedAt: new Date("2026-08-01"),
      endsAt: null,
      daysLeft: 5,
      minutesLeft: 80,
      targetsUsed: 0,
      targetCap: 3,
    })

    const result = await assertScanAllowed("ws-trial", "DEEP", "acct_1")

    expect(result.allowed).toBe(false)
    expect(result.code).toBe("DEEP_NOT_ALLOWED")
    expect(result.isTrial).toBe(true)
  })

  it("allows DEEP on a PRO account with minutes remaining", async () => {
    vi.mocked(resolveAccountBilling).mockResolvedValue(billing("PRO") as never)

    const result = await assertScanAllowed("ws-pro", "DEEP", "acct_1")

    expect(result.allowed).toBe(true)
    expect(result.isTrial).toBe(false)
    expect(result.plan).toBe("PRO")
  })

  it("blocks DEEP on a canceled account past its paid term (effective plan FREE)", async () => {
    vi.mocked(resolveAccountBilling).mockResolvedValue(
      billing("PRO", {
        status: "canceled",
        currentPeriodEnd: new Date(Date.now() - 60_000),
        effectivePlan: "FREE",
      }) as never
    )

    const result = await assertScanAllowed("ws-lapsed", "DEEP", "acct_1")

    expect(result.allowed).toBe(false)
    expect(result.code).toBe("DEEP_NOT_ALLOWED")
    expect(result.plan).toBe("FREE")
  })

  it("keeps DEEP for a canceled account still inside its paid term", async () => {
    vi.mocked(resolveAccountBilling).mockResolvedValue(
      billing("PRO", {
        status: "canceled",
        currentPeriodEnd: new Date(Date.now() + 60_000),
      }) as never
    )

    const result = await assertScanAllowed("ws-in-term", "DEEP", "acct_1")

    expect(result.allowed).toBe(true)
    expect(result.plan).toBe("PRO")
  })

  it("allows STANDARD on a STARTER account (core detection not gated by plan)", async () => {
    vi.mocked(resolveAccountBilling).mockResolvedValue(billing("STARTER") as never)

    const result = await assertScanAllowed("ws-starter", "STANDARD", "acct_1")

    expect(result.allowed).toBe(true)
  })

  it("blocks scans when the account has no remaining minutes", async () => {
    vi.mocked(resolveAccountBilling).mockResolvedValue(billing("PRO") as never)
    vi.mocked(getUsageBalance).mockResolvedValue({ totalRemaining: 0 } as never)

    const result = await assertScanAllowed("ws-empty", "STANDARD", "acct_1")

    expect(result.allowed).toBe(false)
    expect(result.code).toBe("NO_MINUTES_REMAINING")
  })

  it("uses a database aggregate for current-cycle overage", async () => {
    vi.mocked(resolveAccountBilling).mockResolvedValue(
      billing("LAUNCH_ASSURANCE", { spendLimitCents: 1500 }) as never
    )
    vi.mocked(getUsageBalance).mockResolvedValue({ totalRemaining: 0 } as never)
    const { resolveBalanceCycleStart } = await import("./usage/balance")
    vi.mocked(resolveBalanceCycleStart).mockReturnValue(new Date("2026-09-01T00:00:00Z"))
    vi.mocked(prisma.usageRecord.aggregate).mockResolvedValue({
      _sum: { quantity: 10 },
    } as never)

    const result = await assertScanAllowed("ws-overage", "STANDARD", "acct_1")

    expect(result.allowed).toBe(true)
    expect(prisma.usageRecord.aggregate).toHaveBeenCalledWith({
      where: {
        accountId: "acct_1",
        kind: "overage_minutes",
        deletedAt: null,
        cycleStart: { gte: new Date("2026-09-01T00:00:00Z") },
      },
      _sum: { quantity: true },
    })
  })

  it("blocks STANDARD on an expired account trial (TRIAL_EXPIRED)", async () => {
    vi.mocked(resolveAccountBilling).mockResolvedValue(billing("FREE") as never)
    vi.mocked(getAccountTrialState).mockResolvedValue({
      isActive: false,
      isExpired: true,
      startedAt: new Date("2026-01-01"),
      endsAt: new Date("2026-01-15"),
      daysLeft: 0,
      minutesLeft: 0,
      targetsUsed: 0,
      targetCap: 3,
    })

    const result = await assertScanAllowed("ws-trial-expired", "STANDARD", "acct_1")

    expect(result.allowed).toBe(false)
    expect(result.code).toBe("TRIAL_EXPIRED")
  })

  it("allows STANDARD when the account trial target cap is reached (targets are separate)", async () => {
    vi.mocked(resolveAccountBilling).mockResolvedValue(billing("FREE") as never)
    vi.mocked(getAccountTrialState).mockResolvedValue({
      isActive: true,
      isExpired: false,
      startedAt: new Date("2026-08-01"),
      endsAt: null,
      daysLeft: 5,
      minutesLeft: 80,
      targetsUsed: 3,
      targetCap: 3,
    })
    vi.mocked(getUsageBalance).mockResolvedValue({ totalRemaining: 80 } as never)

    const result = await assertScanAllowed("ws-trial-capped", "STANDARD", "acct_1")

    expect(result.allowed).toBe(true)
    expect(result.isTrial).toBe(true)
  })

  it("fails closed when no sponsoring account is resolvable", async () => {
    const result = await assertScanAllowed("ws-any", "STANDARD", null)

    expect(result.allowed).toBe(false)
    expect(result.code).toBe("SPONSOR_REQUIRED")
  })
})

describe("entitlements — protected-target cap on the acting account's plan", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({ id: "ws_1" } as never)
    vi.mocked(getAccountTrialState).mockResolvedValue({
      isActive: false,
      isExpired: false,
      startedAt: null,
      endsAt: null,
      daysLeft: 0,
      minutesLeft: 0,
      targetsUsed: 0,
      targetCap: 3,
    })
  })

  it("blocks a paid plan at its target cap (Pro = 15)", async () => {
    vi.mocked(resolveAccountBilling).mockResolvedValue(billing("PRO") as never)
    vi.mocked(prisma.target.count).mockResolvedValue(15)

    const result = await assertTargetAllowed("ws-pro-full", "acct_1")

    expect(result.allowed).toBe(false)
    expect(result.code).toBe("TARGET_LIMIT_REACHED")
    expect(result.targetsUsed).toBe(15)
    expect(result.targetCap).toBe(15)
  })

  it("blocks a paid plan over its cap (over-cap after downgrade) but never deletes", async () => {
    vi.mocked(resolveAccountBilling).mockResolvedValue(billing("STARTER") as never)
    // Over cap: 6 targets on a 5-cap Starter plan
    vi.mocked(prisma.target.count).mockResolvedValue(6)

    const result = await assertTargetAllowed("ws-starter-over", "acct_1")

    expect(result.allowed).toBe(false)
    expect(result.code).toBe("TARGET_LIMIT_REACHED")
    expect(result.targetsUsed).toBe(6)
    expect(result.targetCap).toBe(5)
  })

  it("allows a paid plan below its cap", async () => {
    vi.mocked(resolveAccountBilling).mockResolvedValue(billing("LAUNCH_ASSURANCE") as never)
    vi.mocked(prisma.target.count).mockResolvedValue(12)

    const result = await assertTargetAllowed("ws-la-ok", "acct_1")

    expect(result.allowed).toBe(true)
    expect(result.targetCap).toBe(50)
  })

  it("allows Enterprise to add targets because its limits are contract-defined", async () => {
    vi.mocked(resolveAccountBilling).mockResolvedValue(billing("ENTERPRISE") as never)
    vi.mocked(prisma.target.count).mockResolvedValue(0)

    const result = await assertTargetAllowed("ws-enterprise", "acct_1")

    expect(result.allowed).toBe(true)
    expect(result.targetCap).toBe(0)
  })

  it("blocks an active account trial at the trial cap", async () => {
    vi.mocked(resolveAccountBilling).mockResolvedValue(billing("FREE") as never)
    vi.mocked(getAccountTrialState).mockResolvedValue({
      isActive: true,
      isExpired: false,
      startedAt: new Date("2026-08-01"),
      endsAt: null,
      daysLeft: 5,
      minutesLeft: 80,
      targetsUsed: 0,
      targetCap: 3,
    })
    vi.mocked(prisma.target.count).mockResolvedValue(3)

    const result = await assertTargetAllowed("ws-trial-capped", "acct_1")

    expect(result.allowed).toBe(false)
    expect(result.code).toBe("TARGET_LIMIT_REACHED")
    expect(result.targetCap).toBe(3)
  })
})

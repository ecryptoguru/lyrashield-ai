import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock dependencies so assertScanAllowed only needs prisma.workspace.findUnique.
vi.mock("@lyrashield/db", () => ({
  prisma: {
    workspace: {
      findUnique: vi.fn(),
    },
    target: {
      count: vi.fn(),
    },
    billingAccount: {
      update: vi.fn(),
      // The overage path (no minutes remaining) calls findUnique. Return a
      // non-TEAM account so overage is not eligible and the gate returns
      // NO_MINUTES_REMAINING without needing the spend-limit overage branch.
      findUnique: vi.fn().mockResolvedValue({
        currentPlan: "PRO",
        spendLimitCents: null,
        currentPeriodStart: new Date(),
      }),
    },
  },
}))

vi.mock("@lyrashield/pricing", () => ({
  CLOUD_PLAN_MAP: {
    FREE: { id: "FREE", deepAllowed: false, agentMinutes: 0, targetCaps: 3 },
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

// Mock the usage/trial/grace modules so the Deep-gating logic is exercised
// in isolation without a full DB balance/trial computation.
vi.mock("./usage/balance", () => ({
  getUsageBalance: vi.fn(),
}))

vi.mock("./trial", () => ({
  getTrialState: vi.fn().mockResolvedValue({ isExpired: false }),
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
import { getUsageBalance } from "./usage/balance"
import { getTrialState } from "./trial"

describe("entitlements — Deep scan gating (Deep = Pro+)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: trial not expired, plenty of minutes, not in grace.
    vi.mocked(getTrialState).mockResolvedValue({ isExpired: false })
    vi.mocked(getUsageBalance).mockResolvedValue({ totalRemaining: 600 })
  })

  it("blocks DEEP on STARTER (deepAllowed=false)", async () => {
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
      plan: "STARTER",
      deepAllowed: false,
      trialStartedAt: null,
    })

    const result = await assertScanAllowed("ws-starter", "DEEP")

    expect(result.allowed).toBe(false)
    expect(result.code).toBe("DEEP_NOT_ALLOWED")
    expect(result.isTrial).toBe(false)
  })

  it("blocks DEEP on a TRIAL workspace (FREE + trialStartedAt, deepAllowed=false)", async () => {
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
      plan: "FREE",
      deepAllowed: false,
      trialStartedAt: new Date("2026-08-01"),
    })
    vi.mocked(getTrialState).mockResolvedValue({ isExpired: false })

    const result = await assertScanAllowed("ws-trial", "DEEP")

    expect(result.allowed).toBe(false)
    expect(result.code).toBe("DEEP_NOT_ALLOWED")
    expect(result.isTrial).toBe(true)
  })

  it("allows DEEP on PRO (deepAllowed=true) with minutes remaining", async () => {
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
      plan: "PRO",
      deepAllowed: true,
      trialStartedAt: null,
    })

    const result = await assertScanAllowed("ws-pro", "DEEP")

    expect(result.allowed).toBe(true)
    expect(result.isTrial).toBe(false)
    expect(result.plan).toBe("PRO")
  })

  it("allows STANDARD on STARTER (core detection not gated by plan)", async () => {
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
      plan: "STARTER",
      deepAllowed: false,
      trialStartedAt: null,
    })

    const result = await assertScanAllowed("ws-starter", "STANDARD")

    // STARTER gets real scans (Safe/Quick/Standard) — only Deep is gated.
    expect(result.allowed).toBe(true)
  })

  it("blocks scans when the workspace has no remaining minutes", async () => {
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
      plan: "PRO",
      deepAllowed: true,
      trialStartedAt: null,
    })
    vi.mocked(getUsageBalance).mockResolvedValue({ totalRemaining: 0 })

    const result = await assertScanAllowed("ws-empty", "STANDARD")

    expect(result.allowed).toBe(false)
  })

  it("blocks STANDARD on an expired trial (TRIAL_EXPIRED)", async () => {
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
      plan: "FREE",
      deepAllowed: false,
      trialStartedAt: new Date("2026-01-01"),
    })
    vi.mocked(getTrialState).mockResolvedValue({
      isExpired: true,
      targetsUsed: 0,
      targetCap: 3,
    })

    const result = await assertScanAllowed("ws-trial-expired", "STANDARD")

    expect(result.allowed).toBe(false)
    expect(result.code).toBe("TRIAL_EXPIRED")
    expect(result.isTrial).toBe(true)
  })

  it("allows STANDARD for an existing target when the trial target cap is reached", async () => {
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
      plan: "FREE",
      deepAllowed: false,
      trialStartedAt: new Date("2026-08-01"),
    })
    vi.mocked(getTrialState).mockResolvedValue({
      isExpired: false,
      targetsUsed: 3,
      targetCap: 3,
    })
    vi.mocked(getUsageBalance).mockResolvedValue({ totalRemaining: 80 })

    const result = await assertScanAllowed("ws-trial-capped", "STANDARD")

    expect(result.allowed).toBe(true)
    expect(result.isTrial).toBe(true)
  })
})

describe("entitlements — protected-target cap (hard-enforced, founder-confirmed 2026-08-29)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("blocks a paid plan at its target cap (Pro = 15)", async () => {
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
      plan: "PRO",
      deepAllowed: true,
      trialStartedAt: null,
    })
    vi.mocked(prisma.target.count).mockResolvedValue(15)

    const result = await assertTargetAllowed("ws-pro-full")

    expect(result.allowed).toBe(false)
    expect(result.code).toBe("TARGET_LIMIT_REACHED")
    expect(result.targetsUsed).toBe(15)
    expect(result.targetCap).toBe(15)
  })

  it("blocks a paid plan over its cap (over-cap after downgrade) but never deletes", async () => {
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
      plan: "STARTER",
      deepAllowed: false,
      trialStartedAt: null,
    })
    // Over cap: 6 targets on a 5-cap Starter plan
    vi.mocked(prisma.target.count).mockResolvedValue(6)

    const result = await assertTargetAllowed("ws-starter-over")

    expect(result.allowed).toBe(false)
    expect(result.code).toBe("TARGET_LIMIT_REACHED")
    expect(result.targetsUsed).toBe(6)
    expect(result.targetCap).toBe(5)
  })

  it("allows a paid plan below its cap", async () => {
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
      plan: "LAUNCH_ASSURANCE",
      deepAllowed: true,
      trialStartedAt: null,
    })
    vi.mocked(prisma.target.count).mockResolvedValue(12)

    const result = await assertTargetAllowed("ws-la-ok")

    expect(result.allowed).toBe(true)
    expect(result.targetCap).toBe(50)
  })

  it("allows Enterprise to add targets because its limits are contract-defined", async () => {
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
      plan: "ENTERPRISE",
      deepAllowed: true,
      trialStartedAt: null,
    })
    vi.mocked(prisma.target.count).mockResolvedValue(0)

    const result = await assertTargetAllowed("ws-enterprise")

    expect(result.allowed).toBe(true)
    expect(result.targetCap).toBe(0)
  })

  it("blocks a trial workspace at the trial cap", async () => {
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
      plan: "FREE",
      deepAllowed: false,
      trialStartedAt: new Date("2026-08-01"),
    })
    vi.mocked(prisma.target.count).mockResolvedValue(3)

    const result = await assertTargetAllowed("ws-trial-capped")

    expect(result.allowed).toBe(false)
    expect(result.code).toBe("TARGET_LIMIT_REACHED")
    expect(result.targetCap).toBe(3)
  })
})

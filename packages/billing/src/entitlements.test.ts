import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock dependencies so assertScanAllowed only needs prisma.workspace.findUnique.
vi.mock("@lyrashield/db", () => ({
  prisma: {
    workspace: {
      findUnique: vi.fn(),
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
    FREE: { id: "FREE", deepAllowed: false, agentMinutes: 0 },
    STARTER: { id: "STARTER", deepAllowed: false, agentMinutes: 300 },
    PRO: { id: "PRO", deepAllowed: true, agentMinutes: 1200 },
    TEAM: { id: "TEAM", deepAllowed: true, agentMinutes: 4000 },
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
  blockOnExpiry: vi.fn(),
}))

vi.mock("./grace", () => ({
  getGraceState: vi.fn().mockResolvedValue({ inGrace: false }),
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { assertScanAllowed } from "./entitlements"
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
})

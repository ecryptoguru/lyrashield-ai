import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock dependencies before importing the module under test.
vi.mock("@lyrashield/db", () => ({
  prisma: {
    workspace: {
      findUnique: vi.fn(),
    },
    billingAccount: {
      update: vi.fn(),
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

vi.mock("./usage/balance", () => ({
  getUsageBalance: vi.fn().mockResolvedValue({ totalRemaining: 600 }),
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

describe("entitlements — Deep scan gating (Deep = Pro+)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

import { describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  withAccountRLS: (_accountId: string, run: (tx: object) => Promise<unknown>) => run({}),
  withWorkspaceRLS: (_workspaceId: string, run: (tx: object) => Promise<unknown>) => run({}),
}))
import type { MyraToolContext } from "./types"
import { runGetMyContext } from "./context"

function context(
  plan: string,
  balance: { totalRemaining: number; packRemaining?: number } | null
): MyraToolContext {
  const trial = {
    isActive: false,
    isExpired: true,
    startedAt: new Date("2026-09-01T00:00:00Z"),
    endsAt: new Date("2026-09-08T00:00:00Z"),
    daysLeft: 0,
    minutesLeft: 37,
    targetsUsed: 1,
    targetCap: 3,
  }
  return {
    principal: {
      kind: "user",
      accountId: "account-1",
      sessionId: "session-1",
      email: "user@example.test",
      emailVerified: true,
      workspaceId: null,
      role: null,
    },
    surface: "DASHBOARD",
    conversationId: null,
    workspaceId: null,
    role: null,
    deps: {
      resolveAccountBilling: vi.fn().mockResolvedValue({ effectivePlan: plan }),
      getAccountTrialState: vi.fn().mockResolvedValue(trial),
      getUsageBalance: vi
        .fn()
        .mockResolvedValue(balance),
      evaluateScanEntitlement: vi.fn(),
    },
  }
}

describe("get_my_context expired trial summary", () => {
  it("forfeits expired FREE trial minutes when no other balance exists", async () => {
    const result = await runGetMyContext(context("FREE", null), {})
    expect(result.data.minutesRemaining).toBe(0)
    expect(result.data.trialExpired).toBe(true)
  })

  it("preserves remaining account balance for a paid plan", async () => {
    const result = await runGetMyContext(context("PRO", { totalRemaining: 80 }), {})
    expect(result.data.minutesRemaining).toBe(80)
  })

  it("reports no usable minutes after an expired FREE trial", async () => {
    const result = await runGetMyContext(
      context("FREE", { totalRemaining: 63, packRemaining: 12 }),
      {}
    )
    expect(result.data.minutesRemaining).toBe(0)
  })
})

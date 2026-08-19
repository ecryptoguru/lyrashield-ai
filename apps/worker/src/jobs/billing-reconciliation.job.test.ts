import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock the billing module
vi.mock("@lyrashield/billing", () => ({
  getPolarClient: vi.fn(() => null),
  getRazorpayClient: vi.fn(() => null),
}))

// Mock prisma
vi.mock("@lyrashield/db", () => ({
  prisma: {
    webhookEvent: {
      findUnique: vi.fn(),
      findMany: vi.fn(() => Promise.resolve([])),
    },
  },
}))

// Mock logger
vi.mock("@lyrashield/logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { runBillingReconciliation } from "./billing-reconciliation.job"

describe("billing-reconciliation.job", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns a result with zero counts when no providers are configured", async () => {
    const result = await runBillingReconciliation()

    expect(result).toBeDefined()
    expect(result.polarChecked).toBe(0)
    expect(result.razorpayChecked).toBe(0)
    expect(result.replayed).toBe(0)
    expect(result.driftAlerts).toBe(0)
    expect(result.alerts).toEqual([])
  })

  it("completes without throwing when providers are unavailable", async () => {
    // The mocks return null for both clients, so reconciliation should
    // gracefully skip both providers and only check unprocessed events.
    const result = await runBillingReconciliation()

    expect(result.polarChecked).toBe(0)
    expect(result.razorpayChecked).toBe(0)
  })
})

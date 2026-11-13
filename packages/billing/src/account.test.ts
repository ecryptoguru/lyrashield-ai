import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const findMany = vi.hoisted(() => vi.fn())
vi.mock("@lyrashield/db", () => ({ prisma: { billingAccount: { findMany } } }))
import { resolveAccountBilling } from "./account"

const now = new Date("2026-10-11T00:00:00Z")
function row(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: status,
    accountId: "acct",
    status,
    currentPlan: "PRO",
    provider: "polar",
    currentPeriodStart: new Date("2026-10-01"),
    currentPeriodEnd: new Date("2026-11-01"),
    updatedAt: now,
    ...overrides,
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  vi.clearAllMocks()
})
afterEach(() => vi.useRealTimers())
describe("account entitlement lifecycle", () => {
  it.each(["paused", "incomplete", "unpaid", "incomplete_expired", "unknown"])(
    "does not grant paid access for %s",
    async (status) => {
      findMany.mockResolvedValue([row(status)])
      expect(await resolveAccountBilling("acct")).toMatchObject({
        currentPlan: "PRO",
        effectivePlan: "FREE",
      })
    }
  )
  it.each(["canceled", "past_due"])(
    "requires a verified future paid term for %s",
    async (status) => {
      for (const currentPeriodEnd of [null, now, new Date("2026-10-10"), new Date(NaN)]) {
        findMany.mockResolvedValue([row(status, { currentPeriodEnd })])
        expect((await resolveAccountBilling("acct"))?.effectivePlan).toBe("FREE")
      }
      findMany.mockResolvedValue([row(status)])
      expect((await resolveAccountBilling("acct"))?.effectivePlan).toBe("PRO")
    }
  )
  it("keeps complimentary active access and active paid contracts", async () => {
    findMany.mockResolvedValue([
      row("active", { provider: "complimentary", currentPeriodEnd: null }),
    ])
    expect((await resolveAccountBilling("acct"))?.effectivePlan).toBe("PRO")
  })
  it.each(["paused", "incomplete", "past_due", "canceled"])(
    "does not let nonentitling %s contracts hide an active trial",
    async (status) => {
      findMany.mockResolvedValue([
        row(status, { currentPeriodEnd: now }),
        row("trialing", { provider: "trial", currentPlan: "FREE" }),
      ])
      expect(await resolveAccountBilling("acct")).toMatchObject({
        id: "trialing",
        effectivePlan: "FREE",
      })
    }
  )
})

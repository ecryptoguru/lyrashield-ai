import { describe, expect, it } from "vitest"
import { computePaidAccountMetrics } from "./growth-metrics"

const NOW = new Date("2026-09-14T00:00:00Z")
const DAY = 24 * 60 * 60 * 1000

const row = (over: Partial<Parameters<typeof computePaidAccountMetrics>[0][0]>) => ({
  accountId: "acct-1",
  provider: "polar",
  status: "active",
  currentPlan: "PRO",
  interval: "monthly",
  currentPeriodEnd: new Date(NOW.getTime() + 30 * DAY),
  canceledAt: null,
  createdAt: new Date(NOW.getTime() - 10 * DAY),
  ...over,
})

describe("computePaidAccountMetrics", () => {
  it("counts only provider-backed active paid accounts", () => {
    const metrics = computePaidAccountMetrics(
      [
        row({ accountId: "paid-1" }),
        row({ accountId: "trial-1", provider: "trial", status: "trialing", currentPlan: "FREE" }),
        row({ accountId: "free-1", status: "free", currentPlan: "FREE" }),
        row({ accountId: "comp-1", provider: "complimentary", currentPlan: "LAUNCH_ASSURANCE" }),
        row({ accountId: "ref-1", status: "refunded", currentPlan: "PRO" }),
        row({ accountId: "canc-1", status: "canceled", currentPlan: "PRO" }),
        row({ accountId: "incomplete-1", status: "incomplete", currentPlan: "STARTER" }),
      ],
      { excludedAccountIds: new Set<string>(), now: NOW }
    )
    expect(metrics.activePaidAccounts).toBe(1)
  })

  it("dedupes multiple billing rows to one paid account", () => {
    const metrics = computePaidAccountMetrics(
      [
        row({ accountId: "acct-1" }),
        row({ accountId: "acct-1", status: "trialing", currentPlan: "FREE", provider: "trial" }),
        row({ accountId: "acct-1", status: "canceled", currentPlan: "STARTER" }),
      ],
      { excludedAccountIds: new Set<string>(), now: NOW }
    )
    expect(metrics.activePaidAccounts).toBe(1)
  })

  it("excludes platform admin accounts even when they carry a paid-looking row", () => {
    const metrics = computePaidAccountMetrics([row({ accountId: "admin-1" })], {
      excludedAccountIds: new Set(["admin-1"]),
      now: NOW,
    })
    expect(metrics.activePaidAccounts).toBe(0)
    expect(metrics.mrrUsd).toBe(0)
  })

  it("computes monthly-equivalent MRR from the USD catalog (annual / 12)", () => {
    const metrics = computePaidAccountMetrics(
      [
        row({ accountId: "a", currentPlan: "STARTER", interval: "monthly" }), // 29
        row({ accountId: "b", currentPlan: "PRO", interval: "annual" }), // 950/12
        row({ accountId: "c", currentPlan: "LAUNCH_ASSURANCE", interval: "monthly" }), // 499
      ],
      { excludedAccountIds: new Set<string>(), now: NOW }
    )
    expect(metrics.activePaidAccounts).toBe(3)
    // 29 + 950/12 + 499 ≈ 607.17 → integer cents math must be exact
    expect(metrics.mrrUsd).toBeCloseTo(607.17, 2)
    expect(metrics.arrUsd).toBeCloseTo(metrics.mrrUsd * 12, 2)
    expect(metrics.planMix).toEqual({ STARTER: 1, PRO: 1, LAUNCH_ASSURANCE: 1 })
  })

  it("counts new paid accounts and cancellations inside the 30d windows", () => {
    const metrics = computePaidAccountMetrics(
      [
        row({ accountId: "new-1", createdAt: new Date(NOW.getTime() - 5 * DAY) }),
        row({ accountId: "old-1", createdAt: new Date(NOW.getTime() - 90 * DAY) }),
        row({
          accountId: "churn-1",
          status: "canceled",
          canceledAt: new Date(NOW.getTime() - 2 * DAY),
        }),
        row({
          accountId: "old-churn",
          status: "canceled",
          canceledAt: new Date(NOW.getTime() - 60 * DAY),
        }),
      ],
      { excludedAccountIds: new Set<string>(), now: NOW }
    )
    expect(metrics.newPaidAccounts30d).toBe(1)
    expect(metrics.canceled30d).toBe(1)
  })

  it("keeps a recent cancellation after downgrade to FREE", () => {
    const metrics = computePaidAccountMetrics(
      [row({ currentPlan: "FREE", status: "canceled", canceledAt: new Date(NOW.getTime() - DAY) })],
      { excludedAccountIds: new Set(), now: NOW }
    )
    expect(metrics.activePaidAccounts).toBe(0)
    expect(metrics.canceled30d).toBe(1)
  })

  it("exposes paying-in-term alongside strictly active", () => {
    const metrics = computePaidAccountMetrics(
      [
        row({ accountId: "act" }),
        row({ accountId: "pd", status: "past_due" }),
        row({
          accountId: "in-term",
          status: "canceled",
          canceledAt: new Date(NOW.getTime() - DAY),
          currentPeriodEnd: new Date(NOW.getTime() + 10 * DAY),
        }),
        row({
          accountId: "lapsed",
          status: "canceled",
          canceledAt: new Date(NOW.getTime() - 40 * DAY),
          currentPeriodEnd: new Date(NOW.getTime() - 10 * DAY),
        }),
      ],
      { excludedAccountIds: new Set<string>(), now: NOW }
    )
    expect(metrics.activePaidAccounts).toBe(1)
    expect(metrics.paidAccountsInTerm).toBe(3)
  })
})

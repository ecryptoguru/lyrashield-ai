import { describe, expect, it } from "vitest"
import { computePaidAccountMetrics, paidAccountMetricsFromAggregate } from "./growth-metrics"

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

describe("paidAccountMetricsFromAggregate", () => {
  it("folds (plan, interval) tallies into the same metrics as the row path", () => {
    const seed = [
      row({ accountId: "a", currentPlan: "STARTER", interval: "monthly" }),
      row({ accountId: "b", currentPlan: "PRO", interval: "annual" }),
      row({ accountId: "c", currentPlan: "PRO", interval: "annual" }),
      row({ accountId: "d", currentPlan: "LAUNCH_ASSURANCE", interval: "monthly" }),
      row({ accountId: "e", currentPlan: "BUSINESS", interval: null }),
    ]
    const expected = computePaidAccountMetrics(seed, {
      excludedAccountIds: new Set<string>(),
      now: NOW,
    })
    // The SQL GROUP BY produces one tally per (plan, interval) pair over the
    // deduped active rows — reproduce that shape here.
    const tallies = new Map<
      string,
      { currentPlan: string; interval: string | null; accounts: number }
    >()
    for (const r of seed) {
      const key = `${r.currentPlan}${r.interval}`
      const tally = tallies.get(key) ?? {
        currentPlan: r.currentPlan,
        interval: r.interval,
        accounts: 0,
      }
      tally.accounts += 1
      tallies.set(key, tally)
    }
    const actual = paidAccountMetricsFromAggregate(
      {
        activePaidAccounts: seed.length,
        paidAccountsInTerm: seed.length,
        newPaidAccounts30d: seed.length,
        canceled30d: 0,
      },
      [...tallies.values()]
    )
    expect(actual.activePaidAccounts).toBe(expected.activePaidAccounts)
    expect(actual.paidAccountsInTerm).toBe(expected.paidAccountsInTerm)
    expect(actual.newPaidAccounts30d).toBe(expected.newPaidAccounts30d)
    expect(actual.canceled30d).toBe(expected.canceled30d)
    expect(actual.planMix).toEqual(expected.planMix)
    expect(actual.mrrUsd).toBeCloseTo(expected.mrrUsd, 10)
    expect(actual.arrUsd).toBeCloseTo(expected.arrUsd, 10)
  })
})

describe("getPaidAccountMetrics SQL aggregate", () => {
  it.runIf(process.env.GROWTH_METRICS_DB_TEST === "1")(
    "produces the same numbers as computePaidAccountMetrics from a seeded set",
    async () => {
      const database = new URL(process.env.DATABASE_URL!)
      if (
        !["127.0.0.1", "localhost"].includes(database.hostname) ||
        !database.pathname.startsWith("/lyra_v18_")
      )
        throw new Error("Local lyra_v18_* database required")
      const { getSystemPrisma } = await import("@lyrashield/db")
      const { getPaidAccountMetrics } = await import("./platform-admin-overview")
      const system = getSystemPrisma()
      const prefix = `gmtest-${crypto.randomUUID()}`
      const acct = (name: string) => `${prefix}-${name}`
      const seed = [
        row({ accountId: acct("a"), currentPlan: "STARTER", interval: "monthly" }),
        row({ accountId: acct("b"), currentPlan: "PRO", interval: "annual" }),
        row({ accountId: acct("pd"), status: "past_due", currentPlan: "PRO" }),
        row({
          accountId: acct("in-term"),
          status: "canceled",
          canceledAt: new Date(NOW.getTime() - DAY),
          currentPeriodEnd: new Date(NOW.getTime() + 10 * DAY),
        }),
        row({
          accountId: acct("lapsed"),
          status: "canceled",
          canceledAt: new Date(NOW.getTime() - 40 * DAY),
          currentPeriodEnd: new Date(NOW.getTime() - 10 * DAY),
        }),
        // Two paid rows on one account — the newest (TEAM, active) wins the
        // dedupe while the older canceled row still feeds canceled30d.
        row({
          accountId: acct("dupe"),
          currentPlan: "STARTER",
          status: "canceled",
          canceledAt: new Date(NOW.getTime() - 2 * DAY),
          createdAt: new Date(NOW.getTime() - 100 * DAY),
        }),
        row({
          accountId: acct("dupe"),
          currentPlan: "TEAM",
          status: "active",
          createdAt: new Date(NOW.getTime() - 20 * DAY),
        }),
        // FREE-plan provider row canceled recently — counts toward canceled30d only.
        row({
          accountId: acct("free-churn"),
          currentPlan: "FREE",
          status: "canceled",
          canceledAt: new Date(NOW.getTime() - DAY),
        }),
        row({ accountId: acct("admin"), currentPlan: "PRO" }),
        row({
          accountId: acct("trial"),
          provider: "trial",
          status: "trialing",
          currentPlan: "FREE",
        }),
        row({ accountId: acct("comp"), provider: "complimentary", currentPlan: "PRO" }),
        row({ accountId: acct("soft-deleted") }),
        row({ accountId: null }),
        row({ accountId: acct("free"), status: "free", currentPlan: "FREE" }),
      ]
      try {
        for (const r of seed) {
          await system.billingAccount.create({
            data: {
              accountId: r.accountId,
              provider: r.provider,
              status: r.status,
              currentPlan: r.currentPlan as never,
              interval: r.interval,
              currentPeriodEnd: r.currentPeriodEnd,
              canceledAt: r.canceledAt,
              createdAt: r.createdAt,
              deletedAt: r.accountId === acct("soft-deleted") ? new Date() : null,
            },
          })
        }
        // The old findMany applied deletedAt: null before the row path ever
        // saw rows — mirror that here. Provider/accountId/admin filtering is
        // applied by both implementations, so those rows stay in the seed.
        const expected = computePaidAccountMetrics(
          seed.filter((r) => r.accountId !== acct("soft-deleted")),
          {
            excludedAccountIds: new Set([acct("admin")]),
            now: NOW,
          }
        )
        const actual = await getPaidAccountMetrics(system, {
          excludedAccountIds: new Set([acct("admin")]),
          now: NOW,
        })
        expect(actual.activePaidAccounts).toBe(expected.activePaidAccounts)
        expect(actual.paidAccountsInTerm).toBe(expected.paidAccountsInTerm)
        expect(actual.newPaidAccounts30d).toBe(expected.newPaidAccounts30d)
        expect(actual.canceled30d).toBe(expected.canceled30d)
        expect(actual.planMix).toEqual(expected.planMix)
        expect(actual.mrrUsd).toBeCloseTo(expected.mrrUsd, 10)
        expect(actual.arrUsd).toBeCloseTo(expected.arrUsd, 10)
        // Sanity: the seeded set exercises every branch, so nothing is trivially zero.
        expect(expected.activePaidAccounts).toBeGreaterThan(0)
        expect(expected.canceled30d).toBeGreaterThan(0)
      } finally {
        await system.billingAccount.deleteMany({
          where: { accountId: { startsWith: prefix } },
        })
        await system.$disconnect()
      }
    },
    30_000
  )
})

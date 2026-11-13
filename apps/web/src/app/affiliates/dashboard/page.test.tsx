import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  affiliate: vi.fn(),
  raw: vi.fn(),
  count: vi.fn(),
  aggregate: vi.fn(),
}))
vi.mock("@/lib/cache", () => ({ getCachedSession: mocks.session }))
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("REDIRECT")
  },
}))
vi.mock("@lyrashield/db", async (importOriginal) => {
  const { Prisma } = await importOriginal<typeof import("@lyrashield/db")>()
  return {
    Prisma,
    prisma: {
      affiliate: { findUnique: mocks.affiliate },
      click: { count: mocks.count },
      user: { count: mocks.count },
      conversion: { count: mocks.count },
      affiliateSubscription: { count: mocks.count },
      commission: { aggregate: mocks.aggregate },
      $queryRaw: mocks.raw,
    },
  }
})
import AffiliateDashboardPage from "./page"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.mockResolvedValue({ userId: "user-1" })
  mocks.affiliate.mockResolvedValue({
    id: "trusted-affiliate-id",
    status: "APPROVED",
    activeReferrals: 0,
    tierThreshold: 10,
    tierRateBps: 3000,
    baseRateBps: 2500,
  })
  mocks.raw.mockResolvedValue([{ count: 42n }])
  mocks.count.mockResolvedValue(100)
  mocks.aggregate.mockResolvedValue({ _sum: { amount: null } })
})

describe("affiliate distinct click aggregation", () => {
  it("counts in PostgreSQL using bound affiliate identity and a bounded date window", async () => {
    const element = await AffiliateDashboardPage({ searchParams: Promise.resolve({ range: "7d" }) })
    const sql = mocks.raw.mock.calls[0]![0]
    expect(sql.text).toContain('COUNT(DISTINCT "visitorId")')
    expect(sql.text).toContain('WHERE "affiliateId" = $1 AND "clickedAt" >= $2')
    expect(sql.values[0]).toBe("trusted-affiliate-id")
    expect(sql.values[1]).toBeInstanceOf(Date)
    expect(sql.text).not.toContain("trusted-affiliate-id")
    expect(element.props.children[2].props.children.props.uniqueClicks).toBe(42)
  })

  it("does not read aggregates for an unapproved affiliate", async () => {
    mocks.affiliate.mockResolvedValue({ id: "trusted-affiliate-id", status: "PENDING" })
    await expect(AffiliateDashboardPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "REDIRECT"
    )
    expect(mocks.raw).not.toHaveBeenCalled()
    expect(mocks.count).not.toHaveBeenCalled()
  })
})

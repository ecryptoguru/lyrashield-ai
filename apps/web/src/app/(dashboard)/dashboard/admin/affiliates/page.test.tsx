import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  operator: vi.fn(),
  affiliates: vi.fn(),
  payouts: vi.fn(),
  affiliateCount: vi.fn(),
  payoutCount: vi.fn(),
}))
vi.mock("@/lib/cache", () => ({ getCachedSession: mocks.session }))
vi.mock("@lyrashield/auth/server", () => ({ isPlatformOperator: mocks.operator }))
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("REDIRECT")
  },
}))
vi.mock("@lyrashield/db", () => ({
  prisma: {
    affiliate: { findMany: mocks.affiliates, count: mocks.affiliateCount },
    payout: { findMany: mocks.payouts, count: mocks.payoutCount },
  },
}))
vi.mock("./admin-actions", () => ({ AffiliateAdminActions: () => null }))
import AffiliateAdminPage from "./page"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.mockResolvedValue({ userId: "operator-1" })
  mocks.operator.mockResolvedValue(true)
  mocks.affiliates.mockResolvedValue([])
  mocks.payouts.mockResolvedValue([])
  mocks.affiliateCount.mockResolvedValue(0)
  mocks.payoutCount.mockResolvedValue(0)
})

describe("affiliate administration pagination", () => {
  it("does not start any global reads before authorization", async () => {
    mocks.operator.mockResolvedValue(false)
    await expect(AffiliateAdminPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "REDIRECT"
    )
    expect(mocks.affiliates).not.toHaveBeenCalled()
    expect(mocks.affiliateCount).not.toHaveBeenCalled()
    expect(mocks.payouts).not.toHaveBeenCalled()
  })

  it("bounds all lists independently with stable ordering and counts each full result set", async () => {
    await AffiliateAdminPage({
      searchParams: Promise.resolve({
        pending: "pending-old",
        approved: "approved-old",
        suspended: "../invalid",
        payouts: "payout-old",
      }),
    })
    for (const [args] of mocks.affiliates.mock.calls) {
      expect(args.take).toBe(26)
      expect(args.orderBy.at(-1)).toEqual({ id: "desc" })
    }
    expect(mocks.affiliates.mock.calls[0]![0]).toMatchObject({
      cursor: { id: "pending-old" },
      skip: 1,
    })
    expect(mocks.affiliates.mock.calls[1]![0]).toMatchObject({
      cursor: { id: "approved-old" },
      skip: 1,
    })
    expect(mocks.affiliates.mock.calls[2]![0]).not.toHaveProperty("cursor")
    expect(mocks.payouts).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 26,
        cursor: { id: "payout-old" },
        skip: 1,
        where: { status: { in: ["PENDING", "PROCESSING"] } },
      })
    )
    expect(mocks.affiliateCount).toHaveBeenCalledTimes(3)
    expect(mocks.payoutCount).toHaveBeenCalledOnce()
  })

  it("shows full counts and links beyond row 25 without resetting the other list positions", async () => {
    const rows = Array.from({ length: 26 }, (_, index) => ({
      id: `pending-${index}`,
      createdAt: new Date("2026-10-01"),
      user: { name: `Applicant ${index}`, email: `user${index}@example.test` },
    }))
    mocks.affiliates.mockImplementation(({ where }) =>
      Promise.resolve(where.status === "PENDING" ? rows : [])
    )
    mocks.affiliateCount.mockImplementation(({ where }) =>
      Promise.resolve(where.status === "PENDING" ? 73 : 0)
    )
    const html = renderToStaticMarkup(
      await AffiliateAdminPage({ searchParams: Promise.resolve({ approved: "approved-old" }) })
    )
    expect(html).toContain("Approval Queue (73)")
    expect(html).toContain("Applicant 24")
    expect(html).not.toContain("Applicant 25")
    expect(html).toContain("pending=pending-24&amp;approved=approved-old#pending")
  })
})

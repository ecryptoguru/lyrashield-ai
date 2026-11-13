import { renderToStaticMarkup } from "react-dom/server"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { getCachedSession, redirect, affiliateFindUnique } = vi.hoisted(() => ({
  getCachedSession: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT")
  }),
  affiliateFindUnique: vi.fn(),
}))

vi.mock("@/lib/cache", () => ({ getCachedSession }))
vi.mock("next/navigation", () => ({ redirect }))
vi.mock("@lyrashield/db", () => ({
  prisma: { affiliate: { findUnique: affiliateFindUnique } },
}))
vi.mock("next/link", async () => {
  const React = await vi.importActual<typeof import("react")>("react")
  return {
    default: ({
      href,
      children,
      className,
    }: {
      href: string
      children: ReactNode
      className?: string
    }) => React.createElement("a", { href, className }, children),
  }
})

import AffiliateApplyPage from "./page"

async function markup(): Promise<string> {
  return renderToStaticMarkup(await AffiliateApplyPage())
}

describe("affiliate apply page — new admission is frozen", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCachedSession.mockResolvedValue({ userId: "user-1" })
    affiliateFindUnique.mockResolvedValue(null)
  })

  it("says applications open soon for a signed-in user with no application", async () => {
    const html = await markup()

    expect(html).toContain("Affiliate applications open soon")
    expect(html).toContain("not accepting new applications yet")
  })

  it("renders no application form", async () => {
    const html = await markup()

    expect(html).not.toContain("Submit Application")
    expect(html).not.toContain("Promotion Methods")
    expect(html).not.toContain("Preferred Payout Method")
    expect(html).not.toContain("Tax Form Status")
    expect(html).not.toContain("acceptTerms")
  })

  it("still shows the existing application status to a prior applicant", async () => {
    affiliateFindUnique.mockResolvedValue({ id: "aff-1", status: "PENDING" })

    const html = await markup()

    expect(html).toContain("Application Submitted")
    expect(html).toContain("Pending")
    expect(html).not.toContain("not accepting new applications yet")
  })

  it("still sends an approved affiliate to the dashboard", async () => {
    affiliateFindUnique.mockResolvedValue({ id: "aff-1", status: "APPROVED" })

    await expect(AffiliateApplyPage()).rejects.toThrow("NEXT_REDIRECT")
    expect(redirect).toHaveBeenCalledWith("/affiliates/dashboard")
  })

  it("still requires a session", async () => {
    getCachedSession.mockResolvedValue(null)

    await expect(AffiliateApplyPage()).rejects.toThrow("NEXT_REDIRECT")
    expect(redirect).toHaveBeenCalledWith("/sign-in?callbackURL=/affiliates/apply")
  })
})

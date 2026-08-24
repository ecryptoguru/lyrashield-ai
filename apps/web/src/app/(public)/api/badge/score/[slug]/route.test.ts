import { beforeEach, describe, expect, it, vi } from "vitest"

const getPublicScorecard = vi.fn()
vi.mock("@lyrashield/db", () => ({ getPublicScorecard }))

const { GET } = await import("./route")

describe("scorecard badge route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getPublicScorecard.mockResolvedValue({ payload: { grade: "A_PLUS" } })
  })

  it("returns a script-free, non-cacheable SVG", async () => {
    const response = await GET(new Request("http://localhost/api/badge/score/slug"), {
      params: Promise.resolve({ slug: "slug" }),
    })
    const svg = await response.text()
    expect(response.headers.get("content-type")).toContain("image/svg+xml")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'")
    expect(svg).toContain("grade A+")
    expect(svg).not.toMatch(/<script|on\w+=/i)
  })

  it("404s revoked, expired, or unknown scorecards", async () => {
    getPublicScorecard.mockResolvedValue(null)
    const response = await GET(new Request("http://localhost/api/badge/score/missing"), {
      params: Promise.resolve({ slug: "missing" }),
    })
    expect(response.status).toBe(404)
  })
})

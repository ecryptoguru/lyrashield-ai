import { beforeEach, describe, expect, it, vi } from "vitest"

const getPublicScorecard = vi.fn()
vi.mock("@lyrashield/db", () => ({ getPublicScorecard }))
vi.mock("next/og", () => ({
  ImageResponse: class extends Response {
    width: number
    height: number

    constructor(_: unknown, options: { width: number; height: number; headers: HeadersInit }) {
      super("png", { headers: options.headers })
      this.width = options.width
      this.height = options.height
    }
  },
}))

const { GET } = await import("./route")

const scorecard = {
  payload: {
    grade: "A",
    scope: "agentic pentest + SCA + secrets",
    scannedAt: "2026-08-24T00:00:00.000Z",
    modelVersion: "lyrashield-score/1.0.0",
    resolvedFindings: 2,
    releaseVerdict: "GO",
    verdictVersion: "lyrashield-score/1.0.0",
  },
  referralCode: "23456789",
  superseded: false,
}

describe("scorecard OG route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getPublicScorecard.mockResolvedValue(scorecard)
  })

  it.each([
    ["wide", 1200, 630],
    ["square", 1080, 1080],
    ["portrait", 1080, 1350],
  ] as const)(
    "renders both %s card variants at the expected size",
    async (format, width, height) => {
      for (const variant of ["grade", "fixes"] as const) {
        const response = (await GET(
          new Request(`http://localhost/api/og/score/slug?variant=${variant}&format=${format}`),
          { params: Promise.resolve({ slug: "slug" }) }
        )) as Response & { width: number; height: number }
        expect([response.width, response.height]).toEqual([width, height])
        expect(response.headers.get("cache-control")).toBe("no-store")
        expect(response.headers.get("content-disposition")).toContain(`${variant}-${format}.png`)
      }
    }
  )

  it("404s revoked, expired, or unknown scorecards", async () => {
    getPublicScorecard.mockResolvedValue(null)
    const response = await GET(new Request("http://localhost/api/og/score/missing"), {
      params: Promise.resolve({ slug: "missing" }),
    })
    expect(response.status).toBe(404)
  })
})

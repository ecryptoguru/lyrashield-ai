import { beforeEach, describe, expect, it, vi } from "vitest"

const getPublicScorecard = vi.fn()
vi.mock("@lyrashield/db", () => ({ getPublicScorecard }))
vi.mock("next/og", () => ({
  ImageResponse: class extends Response {
    width: number
    height: number
    element: unknown

    constructor(
      element: unknown,
      options: { width: number; height: number; headers: HeadersInit }
    ) {
      super("png", { headers: options.headers })
      this.element = element
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

  it("does not say zero findings were fixed", async () => {
    getPublicScorecard.mockResolvedValue({
      ...scorecard,
      payload: { ...scorecard.payload, resolvedFindings: 0 },
    })
    const response = (await GET(
      new Request("http://localhost/api/og/score/slug?variant=fixes&format=square"),
      { params: Promise.resolve({ slug: "slug" }) }
    )) as Response & { element: unknown }
    const text = collectText(response.element).join(" ")
    expect(text).toContain("No retest-confirmed fixes reported")
    expect(text).not.toContain("0 findings fixed")
  })
})

function collectText(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number") return [String(value)]
  if (Array.isArray(value)) return value.flatMap(collectText)
  if (value && typeof value === "object" && "props" in value) {
    return collectText((value as { props?: { children?: unknown } }).props?.children)
  }
  return []
}

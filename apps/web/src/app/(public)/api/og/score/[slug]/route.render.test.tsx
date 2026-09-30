import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildLiteScorecardPayload } from "@lyrashield/security"
import { createLiteScorecardToken } from "@/lib/lite-scorecard"

const { getPublicScorecard } = vi.hoisted(() => ({ getPublicScorecard: vi.fn() }))
vi.mock("@lyrashield/db", () => ({ getPublicScorecard }))
// Keep next/og real: consuming its stream exercises the installed Satori/PNG renderer.
const { GET: scoreImage } = await import("./route")
const { GET: liteImage } = await import("../../lite-check/[token]/route")

const scorecard = {
  payload: {
    grade: "A_PLUS",
    scope: "agentic pentest + SCA + secrets",
    scannedAt: "2026-09-30T00:00:00.000Z",
    modelVersion: "lyrashield-score/1.0.0",
    resolvedFindings: 2,
    releaseVerdict: "GO",
    verdictVersion: "lyrashield-score/1.0.0",
  },
  referralCode: "23456789",
  superseded: false,
}

async function expectPng(response: Response, width: number, height: number) {
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("image/png")
  const png = Buffer.from(await response.arrayBuffer())
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  expect(png.toString("ascii", 12, 16)).toBe("IHDR")
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([width, height])
  expect(png.length).toBeGreaterThan(1024)
}

describe("real OG PNG rendering", () => {
  afterEach(() => vi.unstubAllEnvs())

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("BETTER_AUTH_SECRET", "og-render-test-secret-at-least-32-characters")
    getPublicScorecard.mockResolvedValue(scorecard)
  })

  it.each([
    ["wide", 1200, 630],
    ["square", 1080, 1080],
    ["portrait", 1080, 1350],
  ] as const)("renders grade and fixes PNGs in %s format", async (format, width, height) => {
    for (const variant of ["grade", "fixes"] as const) {
      const response = await scoreImage(
        new Request(`http://localhost/api/og/score/slug?variant=${variant}&format=${format}`),
        { params: Promise.resolve({ slug: "slug" }) }
      )
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("content-disposition")).toBe(
        `inline; filename="lyrashield-${variant}-${format}.png"`
      )
      await expectPng(response, width, height)
    }
  })

  it("renders malicious-looking text as image content without fetching it", async () => {
    getPublicScorecard.mockResolvedValue({
      ...scorecard,
      payload: {
        ...scorecard.payload,
        scope: '<script>alert(1)</script> ${7 * 7} <img src="http://127.0.0.1/secret">',
      },
    })
    const fetch = vi.spyOn(globalThis, "fetch")
    try {
      const response = await scoreImage(new Request("http://localhost/api/og/score/slug"), {
        params: Promise.resolve({ slug: "slug" }),
      })
      await expectPng(response, 1200, 630)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
    }
  })

  it("rechecks publication after a successful render so revoked cards return 404", async () => {
    const request = new Request("http://localhost/api/og/score/slug")
    const context = { params: Promise.resolve({ slug: "slug" }) }
    await expectPng(await scoreImage(request, context), 1200, 630)
    getPublicScorecard.mockResolvedValue(null)
    const response = await scoreImage(request, context)
    expect(response.status).toBe(404)
    expect((await response.arrayBuffer()).byteLength).toBe(0)
    expect(getPublicScorecard).toHaveBeenCalledTimes(2)
  })

  it.each([0, 1, 3])(
    "renders authenticated Lite counts (%s) with immutable caching",
    async (count) => {
      const token = createLiteScorecardToken(
        buildLiteScorecardPayload({ needsAttention: count, worthReviewing: 0, looksOk: 2 })
      )
      const response = await liteImage(new Request(`http://localhost/api/og/lite-check/${token}`), {
        params: Promise.resolve({ token }),
      })
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
      expect(response.headers.get("content-disposition")).toBe(
        'inline; filename="lyrashield-lite-check.png"'
      )
      await expectPng(response, 1200, 630)
    }
  )

  it.each([
    ["unknown", "unknown"],
    ["markup", "<script>alert(1)</script>"],
    ["extra segment", "a.b.c"],
    ["oversized", "a".repeat(1025)],
  ])("rejects malformed Lite token (%s)", async (_name, token) => {
    const response = await liteImage(new Request("http://localhost/api/og/lite-check/invalid"), {
      params: Promise.resolve({ token }),
    })
    expect(response.status).toBe(404)
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  })

  it("rejects tampered Lite signatures and tokens signed with a retired secret", async () => {
    const token = createLiteScorecardToken(
      buildLiteScorecardPayload({ needsAttention: 1, worthReviewing: 0, looksOk: 2 })
    )
    const [encoded, signature] = token.split(".")
    const tampered = `${encoded}.${signature![0] === "a" ? "b" : "a"}${signature!.slice(1)}`
    const request = new Request("http://localhost/api/og/lite-check/invalid")
    expect(
      (await liteImage(request, { params: Promise.resolve({ token: tampered }) })).status
    ).toBe(404)
    vi.stubEnv("BETTER_AUTH_SECRET", "rotated-og-test-secret-at-least-32-characters")
    expect((await liteImage(request, { params: Promise.resolve({ token }) })).status).toBe(404)
  })
})

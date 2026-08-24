import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHmac } from "node:crypto"

const recordScorecardEvent = vi.fn()
vi.mock("@lyrashield/db", () => ({ recordScorecardEvent }))

const { POST } = await import("./route")

function request(body: unknown, cookie?: string) {
  return new Request("http://localhost/api/scorecards/events", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
}

const valid = {
  slug: "23456789ABCDEFGH",
  eventType: "SHARE",
  channel: "linkedin",
  variant: "grade",
  source: "public",
  visitorId: "019f5bb9-ac8b-7d33-b722-e441080b4c5a",
}

describe("POST /api/scorecards/events", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-characters-long"
    recordScorecardEvent.mockResolvedValue({ recorded: true })
  })

  it("accepts only the privacy-safe event allowlist", async () => {
    const response = await POST(request(valid))
    expect(response.status).toBe(201)
    expect(recordScorecardEvent).toHaveBeenCalledWith(
      valid.slug,
      expect.objectContaining({
        eventType: "SHARE",
        channel: "linkedin",
        visitorId: expect.any(String),
      })
    )
    expect(recordScorecardEvent.mock.calls[0]?.[1].visitorId).toBe(valid.visitorId)
    expect(response.headers.getSetCookie().join(";")).toContain("ls_scorecard_visitor=")
  })

  it("uses the client UUID for concurrent first-page events", async () => {
    await Promise.all([POST(request(valid)), POST(request(valid))])
    expect(recordScorecardEvent.mock.calls.map((call) => call[1].visitorId)).toEqual([
      valid.visitorId,
      valid.visitorId,
    ])
  })

  it("prefers a valid signed cookie over a submitted UUID", async () => {
    const secret = process.env.BETTER_AUTH_SECRET!
    const cookieId = "019f5bb9-ac8b-7d33-b722-e441080b4c5b"
    const signature = createHmac("sha256", secret).update(cookieId).digest("hex")
    await POST(request(valid, `ls_scorecard_visitor=${cookieId}.${signature}`))
    expect(recordScorecardEvent.mock.calls[0]?.[1].visitorId).toBe(cookieId)
  })

  it("requires a channel for share handoffs and rejects sensitive extra properties", async () => {
    expect((await POST(request({ ...valid, channel: undefined }))).status).toBe(400)
    expect((await POST(request({ ...valid, targetUrl: "https://private.test" }))).status).toBe(400)
  })
})

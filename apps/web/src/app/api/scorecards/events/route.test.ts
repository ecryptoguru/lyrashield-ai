import { beforeEach, describe, expect, it, vi } from "vitest"

const recordScorecardEvent = vi.fn()
vi.mock("@lyrashield/db", () => ({ recordScorecardEvent }))

const { POST } = await import("./route")

function request(body: unknown) {
  return new Request("http://localhost/api/scorecards/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
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
    recordScorecardEvent.mockResolvedValue({ recorded: true })
  })

  it("accepts only the privacy-safe event allowlist", async () => {
    const response = await POST(request(valid))
    expect(response.status).toBe(201)
    expect(recordScorecardEvent).toHaveBeenCalledWith(valid.slug, valid)
  })

  it("requires a channel for share handoffs and rejects sensitive extra properties", async () => {
    expect((await POST(request({ ...valid, channel: undefined }))).status).toBe(400)
    expect((await POST(request({ ...valid, targetUrl: "https://private.test" }))).status).toBe(400)
  })
})

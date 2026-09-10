import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHmac } from "node:crypto"

const recordScorecardEvent = vi.fn()
vi.mock("@lyrashield/db", () => ({ recordScorecardEvent }))

const { POST } = await import("./route")

function request(body: unknown, cookie?: string, privacyHeaders?: Record<string, string>) {
  return new Request("http://localhost/api/scorecards/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...privacyHeaders,
    },
    body: JSON.stringify(body),
  })
}

const valid = {
  slug: "23456789ABCDEFGH",
  eventType: "SHARE",
  channel: "linkedin",
  variant: "grade",
  source: "public",
}

describe("POST /api/scorecards/events", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-characters-long"
    recordScorecardEvent.mockResolvedValue({ recorded: true })
  })

  it("mints the visitor server-side when no signed cookie exists", async () => {
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
    // v16 2.3: the id is server-minted, never client-supplied.
    expect(recordScorecardEvent.mock.calls[0]?.[1].visitorId).not.toBe(
      "019f5bb9-ac8b-7d33-b722-e441080b4c5a"
    )
    expect(response.headers.getSetCookie().join(";")).toContain("ls_scorecard_visitor=")
  })

  it("rejects a body-supplied visitorId outright (per-visitor dedupe cannot be bypassed)", async () => {
    // The strict schema refuses the field: a script posting fresh UUIDs must
    // not be able to inflate VIEW and SHARE counts past the daily dedupe.
    const response = await POST(
      request({ ...valid, visitorId: "019f5bb9-ac8b-7d33-b722-e441080b4c5a" })
    )
    expect(response.status).toBe(400)
    expect(recordScorecardEvent).not.toHaveBeenCalled()
  })

  it("mints independent visitors for concurrent cookieless first events", async () => {
    // Two first-visit posts with no cookie each get their own server-minted
    // id (each response sets its own cookie); repeat visits dedupe by the
    // signed cookie, asserted below.
    await Promise.all([POST(request(valid)), POST(request(valid))])
    const ids = recordScorecardEvent.mock.calls.map((call) => call[1].visitorId)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it("prefers a valid signed cookie over minting a new visitor", async () => {
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

  it.each([
    ["DNT", { dnt: "1" }],
    ["GPC", { "sec-gpc": "1" }],
  ])(
    "suppresses server-side event capture and visitor cookies for %s",
    async (_signal, headers) => {
      const response = await POST(request(valid, undefined, headers))

      expect(response.status).toBe(204)
      expect(response.headers.get("Cache-Control")).toBe("private, no-store")
      expect(response.headers.getSetCookie()).toEqual([])
      expect(recordScorecardEvent).not.toHaveBeenCalled()
    }
  )
})

import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({ MYRA_PUBLIC_ENABLED: "1" }))
const mocks = vi.hoisted(() => ({
  getDemoSlots: vi.fn(),
  resolveMyraRequest: vi.fn(),
  checkMyraRateLimit: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock("@lyrashield/config", () => ({ env }))
vi.mock("@lyrashield/myra/server", () => ({
  getDemoSlots: mocks.getDemoSlots,
  resolveMyraRequest: mocks.resolveMyraRequest,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: mocks.logger,
  setRequestId: vi.fn(),
  setRequestIdResolver: vi.fn(),
}))
vi.mock("@/lib/rate-limit", () => ({
  checkMyraRateLimit: mocks.checkMyraRateLimit,
  clientIpFromRequest: () => "203.0.113.1",
}))

const { POST } = await import("./route")

const slots = {
  timezone: "Asia/Kolkata",
  hostTimezone: "Asia/Kolkata",
  durationMinutes: 30,
  slots: [
    { id: "slot-1", startsAt: "2026-10-10T10:00:00.000Z", endsAt: "2026-10-10T10:30:00.000Z" },
  ],
}
const anonymous = {
  principal: { kind: "anonymous", publicSessionId: "public-session-1" },
  workspaceId: null,
  role: null,
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://app.lyrashieldai.com/api/myra/demo/slots", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

describe("POST /api/myra/demo/slots", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    env.MYRA_PUBLIC_ENABLED = "1"
    mocks.resolveMyraRequest.mockResolvedValue(anonymous)
    mocks.checkMyraRateLimit.mockResolvedValue({ limited: false })
    mocks.getDemoSlots.mockResolvedValue(slots)
  })

  it("returns availability to a no-cookie bearer and rate-limits by its verified session", async () => {
    const response = await POST(
      request(
        { timezone: "Asia/Kolkata", from: "2026-10-10" },
        { "x-myra-session": "public-token" }
      ) as never
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ success: true, data: slots })
    expect(mocks.resolveMyraRequest).toHaveBeenCalledOnce()
    expect(mocks.checkMyraRateLimit).toHaveBeenCalledWith("message", "ps:public-session-1")
    expect(mocks.getDemoSlots).toHaveBeenCalledWith("Asia/Kolkata", "2026-10-10")
  })

  it("rate-limits an unresolved public caller by IP before querying calendar availability", async () => {
    mocks.resolveMyraRequest.mockResolvedValue(null)

    const response = await POST(request({ timezone: "Asia/Kolkata", from: "2026-10-10" }) as never)

    expect(response.status).toBe(200)
    expect(mocks.checkMyraRateLimit).toHaveBeenCalledWith("message", "203.0.113.1")
    expect(mocks.getDemoSlots).toHaveBeenCalledWith("Asia/Kolkata", "2026-10-10")
  })

  it("stops before the calendar provider when the message limit is exhausted", async () => {
    mocks.checkMyraRateLimit.mockResolvedValue({ limited: true, retryAfter: 60 })

    const response = await POST(
      request(
        { timezone: "Asia/Kolkata", from: "2026-10-10" },
        { "x-myra-session": "public-token" }
      ) as never
    )

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("60")
    expect(mocks.getDemoSlots).not.toHaveBeenCalled()
  })

  it("validates timezone and date before resolving a principal or calling calendar", async () => {
    const response = await POST(
      request({ timezone: "UTC", from: "next-week", workspaceId: "attacker-workspace" }) as never
    )

    expect(response.status).toBe(400)
    expect(mocks.resolveMyraRequest).not.toHaveBeenCalled()
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.getDemoSlots).not.toHaveBeenCalled()
  })

  it("hides the availability endpoint when the public surface is disabled", async () => {
    env.MYRA_PUBLIC_ENABLED = "0"

    const response = await POST(request({ timezone: "Asia/Kolkata", from: "2026-10-10" }) as never)

    expect(response.status).toBe(404)
    expect(mocks.resolveMyraRequest).not.toHaveBeenCalled()
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.getDemoSlots).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  MYRA_PUBLIC_ENABLED: "1",
  MYRA_WRITES_ENABLED: "1",
  MYRA_PUBLIC_BOOKING_ENABLED: "1",
  NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
}))
const mocks = vi.hoisted(() => ({
  manageBooking: vi.fn(),
  checkMyraRateLimit: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock("@lyrashield/config", () => ({ env }))
vi.mock("@lyrashield/myra/server", () => ({ manageBooking: mocks.manageBooking }))
vi.mock("@lyrashield/logger", () => ({
  logger: mocks.logger,
  setRequestId: vi.fn(),
  setRequestIdResolver: vi.fn(),
}))
vi.mock("@/lib/rate-limit", () => ({
  checkMyraRateLimit: mocks.checkMyraRateLimit,
  clientIpFromRequest: () => "203.0.113.1",
}))

const { GET, POST } = await import("./route")
const params = Promise.resolve({ token: "opaque-booking-manage-token" })

function getRequest() {
  return new Request(
    "https://app.lyrashieldai.com/api/myra/demo/manage/opaque-booking-manage-token"
  )
}

function postRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request(
    "https://app.lyrashieldai.com/api/myra/demo/manage/opaque-booking-manage-token",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }
  )
}

describe("Myra demo manage route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    env.MYRA_PUBLIC_ENABLED = "1"
    env.MYRA_WRITES_ENABLED = "1"
    env.MYRA_PUBLIC_BOOKING_ENABLED = "1"
    mocks.checkMyraRateLimit.mockResolvedValue({ limited: false })
    mocks.manageBooking.mockResolvedValue({ status: "CONFIRMED", bookingId: "booking-1" })
  })

  it("reads the booking only through the manage token credential", async () => {
    const response = await GET(getRequest() as never, { params } as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { status: "CONFIRMED", bookingId: "booking-1" },
    })
    expect(mocks.checkMyraRateLimit).toHaveBeenCalledWith("message", "203.0.113.1")
    expect(mocks.manageBooking).toHaveBeenCalledWith("opaque-booking-manage-token", "get")
  })

  it("rejects an overlong manage token before rate limiting or booking lookup", async () => {
    const response = await GET(
      getRequest() as never,
      {
        params: Promise.resolve({ token: "t".repeat(257) }),
      } as never
    )

    expect(response.status).toBe(400)
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.manageBooking).not.toHaveBeenCalled()
  })

  it("applies a cancellation for the token owner without requiring a browser session", async () => {
    const response = await POST(postRequest({ action: "cancel" }) as never, { params } as never)

    expect(response.status).toBe(200)
    expect(mocks.checkMyraRateLimit).toHaveBeenCalledWith("message", "203.0.113.1")
    expect(mocks.manageBooking).toHaveBeenCalledWith(
      "opaque-booking-manage-token",
      "cancel",
      undefined
    )
  })

  it("allows a same-origin cookie request that carries the manage token", async () => {
    const response = await POST(
      postRequest(
        { action: "cancel" },
        {
          cookie: "lyra.session=browser-session",
          origin: "https://app.lyrashieldai.com",
          "sec-fetch-site": "same-origin",
        }
      ) as never,
      { params } as never
    )

    expect(response.status).toBe(200)
    expect(mocks.manageBooking).toHaveBeenCalledWith(
      "opaque-booking-manage-token",
      "cancel",
      undefined
    )
  })

  it("passes the confirmed reschedule slot with the manage token, not a client booking id", async () => {
    const response = await POST(
      postRequest({
        action: "reschedule",
        newSlotStart: "2026-10-10T10:00:00.000Z",
      }) as never,
      { params } as never
    )

    expect(response.status).toBe(200)
    expect(mocks.manageBooking).toHaveBeenCalledWith(
      "opaque-booking-manage-token",
      "reschedule",
      "2026-10-10T10:00:00.000Z"
    )
  })

  it("rejects a cross-origin cookie mutation before rate limiting or booking mutation", async () => {
    const response = await POST(
      postRequest(
        { action: "cancel" },
        {
          cookie: "lyra.session=browser-session",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        }
      ) as never,
      { params } as never
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } })
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.manageBooking).not.toHaveBeenCalled()
  })

  it("rejects a client-supplied booking identifier rather than acting on arbitrary bookings", async () => {
    const response = await POST(
      postRequest({ action: "cancel", bookingId: "other-booking" }) as never,
      { params } as never
    )

    expect(response.status).toBe(400)
    expect(mocks.manageBooking).not.toHaveBeenCalled()
  })

  it("hides public management when public booking is disabled", async () => {
    env.MYRA_PUBLIC_BOOKING_ENABLED = "0"

    const response = await POST(postRequest({ action: "cancel" }) as never, { params } as never)

    expect(response.status).toBe(404)
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.manageBooking).not.toHaveBeenCalled()
  })

  it("keeps booking lookup hidden when the public surface is disabled", async () => {
    env.MYRA_PUBLIC_ENABLED = "0"

    const response = await GET(getRequest() as never, { params } as never)

    expect(response.status).toBe(404)
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.manageBooking).not.toHaveBeenCalled()
  })
})

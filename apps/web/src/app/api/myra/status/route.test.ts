import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  MYRA_PUBLIC_ENABLED: "0",
  MYRA_WRITES_ENABLED: "0",
  MYRA_ALLOWED_EMAILS: "",
  MYRA_PUBLIC_BOOKING_ENABLED: "0",
}))

vi.mock("@lyrashield/config", () => ({ env }))

const { GET } = await import("./route")

function statusRequest(origin?: string): Request {
  return new Request("https://app.lyrashieldai.com/api/myra/status", {
    headers: origin ? { origin } : {},
  })
}

describe("GET /api/myra/status", () => {
  beforeEach(() => {
    env.MYRA_PUBLIC_ENABLED = "0"
    env.MYRA_WRITES_ENABLED = "0"
    env.MYRA_ALLOWED_EMAILS = ""
    env.MYRA_PUBLIC_BOOKING_ENABLED = "0"
    vi.stubEnv("NEXT_PUBLIC_MARKETING_URL", "https://lyrashieldai.com")
    return () => vi.unstubAllEnvs()
  })

  it("reports public:false and booking:false when both surfaces are off", async () => {
    const body = await (await GET(statusRequest())).json()
    expect(body).toEqual({ public: false, booking: false })
  })

  it("reports booking:true only with the explicit public-booking flag", async () => {
    env.MYRA_PUBLIC_ENABLED = "1"
    env.MYRA_WRITES_ENABLED = "1"
    let body = await (await GET(statusRequest())).json()
    expect(body).toEqual({ public: true, booking: false })

    // The old account allowlist has no bearing on public booking.
    env.MYRA_ALLOWED_EMAILS = "ankit@lyrashieldai.com"
    body = await (await GET(statusRequest())).json()
    expect(body).toEqual({ public: true, booking: false })

    env.MYRA_WRITES_ENABLED = "0"
    env.MYRA_ALLOWED_EMAILS = ""
    body = await (await GET(statusRequest())).json()
    expect(body).toEqual({ public: true, booking: false })
  })

  it("reports booking:true for an allowlisted deployment once public booking is on", async () => {
    // D1 ruled: public demo booking is wanted — the flag reopens the picker
    // on deployments that always set the account allowlist.
    env.MYRA_WRITES_ENABLED = "1"
    env.MYRA_ALLOWED_EMAILS = "ankit@lyrashieldai.com"
    let body = await (await GET(statusRequest())).json()
    expect(body).toEqual({ public: false, booking: false })

    env.MYRA_PUBLIC_BOOKING_ENABLED = "1"
    body = await (await GET(statusRequest())).json()
    expect(body).toEqual({ public: false, booking: false })

    env.MYRA_PUBLIC_ENABLED = "1"
    body = await (await GET(statusRequest())).json()
    expect(body).toEqual({ public: true, booking: true })

    // The flag never opens booking while writes themselves are off.
    env.MYRA_WRITES_ENABLED = "0"
    body = await (await GET(statusRequest())).json()
    expect(body).toEqual({ public: true, booking: false })
  })

  it("sends CORS headers to the marketing origin and none elsewhere", async () => {
    const allowed = await GET(statusRequest("https://lyrashieldai.com"))
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://lyrashieldai.com")
    expect(allowed.headers.get("Cache-Control")).toContain("max-age")

    const denied = await GET(statusRequest("https://evil.example.com"))
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull()
    expect(denied.headers.get("Vary")).toBe("Origin")

    const noOrigin = await GET(statusRequest())
    expect(noOrigin.headers.get("Vary")).toBe("Origin")
  })
})

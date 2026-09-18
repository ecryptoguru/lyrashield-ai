import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  MYRA_PUBLIC_ENABLED: "0",
  MYRA_WRITES_ENABLED: "0",
  MYRA_ALLOWED_EMAILS: "",
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
    vi.stubEnv("NEXT_PUBLIC_MARKETING_URL", "https://lyrashieldai.com")
    return () => vi.unstubAllEnvs()
  })

  it("reports public:false and booking:false when both surfaces are off", async () => {
    const body = await (await GET(statusRequest())).json()
    expect(body).toEqual({ public: false, booking: false })
  })

  it("reports booking:true only when writes are open and no allowlist narrows anonymous callers", async () => {
    env.MYRA_PUBLIC_ENABLED = "1"
    env.MYRA_WRITES_ENABLED = "1"
    let body = await (await GET(statusRequest())).json()
    expect(body).toEqual({ public: true, booking: true })

    // An account allowlist closes anonymous booking even while writes stay on.
    env.MYRA_ALLOWED_EMAILS = "ankit@lyrashieldai.com"
    body = await (await GET(statusRequest())).json()
    expect(body).toEqual({ public: true, booking: false })

    env.MYRA_WRITES_ENABLED = "0"
    env.MYRA_ALLOWED_EMAILS = ""
    body = await (await GET(statusRequest())).json()
    expect(body).toEqual({ public: true, booking: false })
  })

  it("sends CORS headers to the marketing origin and none elsewhere", async () => {
    const allowed = await GET(statusRequest("https://lyrashieldai.com"))
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://lyrashieldai.com")
    expect(allowed.headers.get("Cache-Control")).toContain("max-age")

    const denied = await GET(statusRequest("https://evil.example.com"))
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import { OPTIONS, POST } from "./route"

const MARKETING_ORIGIN = "https://lyrashieldai.com"
const OPTIONAL_COOKIE_NAMES = ["lyrashield-acq", "ls_ref", "ls_ref_source", "ls_scorecard_visitor"]

function request(origin: string | null = MARKETING_ORIGIN, method: "OPTIONS" | "POST" = "POST") {
  const headers = new Headers()
  if (origin !== null) headers.set("origin", origin)
  return new Request("https://app.lyrashieldai.com/api/privacy/analytics-opt-out", {
    method,
    headers,
  })
}

describe("/api/privacy/analytics-opt-out", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_MARKETING_URL", MARKETING_ORIGIN)
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.lyrashieldai.com")
  })

  it("expires every server-held optional cookie for the configured marketing origin", async () => {
    const response = await POST(request())
    const cookies = response.headers.getSetCookie()

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe(MARKETING_ORIGIN)
    expect(response.headers.get("access-control-allow-credentials")).toBe("true")
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(cookies).toHaveLength(OPTIONAL_COOKIE_NAMES.length * 2)

    for (const name of OPTIONAL_COOKIE_NAMES) {
      const expirations = cookies.filter((cookie) => cookie.startsWith(`${name}=`))

      expect(expirations).toHaveLength(2)
      expect(expirations.some((cookie) => cookie.includes("Domain=.lyrashieldai.com"))).toBe(true)
      expect(expirations.some((cookie) => !cookie.includes("Domain="))).toBe(true)
      for (const cookie of expirations) {
        expect(cookie).toContain("Path=/")
        expect(cookie).toContain("Max-Age=0")
        expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT")
        expect(cookie).toContain("SameSite=Lax")
        expect(cookie).toContain("Secure")
      }
    }
  })

  it.each([
    ["attacker", "https://attacker.example"],
    ["missing", null],
    ["null", "null"],
  ] as const)("rejects POST with a %s origin", async (_kind, origin) => {
    const response = await POST(request(origin))

    expect(response.status).toBe(403)
    expect(response.headers.getSetCookie()).toEqual([])
  })

  it("allows a preflight from the exact configured marketing origin", async () => {
    const response = await OPTIONS(request(MARKETING_ORIGIN, "OPTIONS"))

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe(MARKETING_ORIGIN)
    expect(response.headers.get("access-control-allow-methods")).toContain("POST")
  })

  it.each([
    ["attacker", "https://attacker.example"],
    ["missing", null],
    ["null", "null"],
  ] as const)("rejects preflight with a %s origin", async (_kind, origin) => {
    const response = await OPTIONS(request(origin, "OPTIONS"))

    expect(response.status).toBe(403)
  })
})

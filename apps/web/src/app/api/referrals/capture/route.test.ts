import { beforeEach, describe, expect, it, vi } from "vitest"

const findUnique = vi.fn()
vi.mock("@lyrashield/db", () => ({ prisma: { referralCode: { findUnique } } }))

const { POST } = await import("./route")

function request(body: unknown) {
  return new Request("http://localhost/api/referrals/capture", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/referrals/capture", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findUnique.mockResolvedValue({ id: "ref-1" })
  })

  it("stores an allowlisted attribution source in an HttpOnly cookie", async () => {
    const response = await POST(request({ code: "23456789", source: "linkedin" }))
    expect(response.status).toBe(200)
    const cookies = response.headers.getSetCookie().join(";")
    expect(cookies).toContain("ls_ref=23456789")
    expect(cookies).toContain("ls_ref_source=linkedin")
    expect(cookies).toContain("HttpOnly")
  })

  it("rejects unknown attribution sources", async () => {
    expect((await POST(request({ code: "23456789", source: "private-url" }))).status).toBe(400)
    expect(findUnique).not.toHaveBeenCalled()
  })
})

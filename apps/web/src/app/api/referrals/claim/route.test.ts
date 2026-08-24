import { beforeEach, describe, expect, it, vi } from "vitest"

const attributeReferral = vi.fn()
const getSession = vi.fn()
const getClientIP = vi.fn()
const cookieStore = {
  get: vi.fn(),
  delete: vi.fn(),
}

vi.mock("@lyrashield/db", () => ({ attributeReferral }))
vi.mock("@lyrashield/auth/server", () => ({ getSession }))
vi.mock("@lyrashield/config", () => ({
  env: { BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long" },
}))
vi.mock("@/proxy", () => ({ getClientIP }))
vi.mock("next/headers", () => ({ cookies: vi.fn().mockResolvedValue(cookieStore) }))

const { POST } = await import("./route")

describe("POST /api/referrals/claim", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSession.mockResolvedValue({ userId: "new-user" })
    getClientIP.mockReturnValue("203.0.113.1")
    cookieStore.get.mockImplementation((name: string) =>
      name === "ls_ref"
        ? { value: "23456789" }
        : name === "ls_ref_source"
          ? { value: "linkedin" }
          : undefined
    )
    attributeReferral.mockResolvedValue({ id: "attribution-1" })
  })

  it("claims referral and clears both continuity cookies", async () => {
    const response = await POST(new Request("http://localhost/api/referrals/claim") as never)
    expect(response.status).toBe(200)
    expect(attributeReferral).toHaveBeenCalledWith(
      "23456789",
      "new-user",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      "linkedin"
    )
    expect(cookieStore.delete.mock.calls).toEqual([["ls_ref"], ["ls_ref_source"]])
  })

  it("requires authentication and leaves cookies untouched", async () => {
    getSession.mockResolvedValue(null)
    const response = await POST(new Request("http://localhost/api/referrals/claim") as never)
    expect(response.status).toBe(401)
    expect(attributeReferral).not.toHaveBeenCalled()
    expect(cookieStore.delete).not.toHaveBeenCalled()
  })

  it("does nothing without a referral cookie", async () => {
    cookieStore.get.mockReturnValue(undefined)
    const response = await POST(new Request("http://localhost/api/referrals/claim") as never)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: { attributed: false } })
    expect(attributeReferral).not.toHaveBeenCalled()
  })

  it("does not persist a forged referral source", async () => {
    cookieStore.get.mockImplementation((name: string) =>
      name === "ls_ref" ? { value: "23456789" } : { value: "private-target" }
    )
    await POST(new Request("http://localhost/api/referrals/claim") as never)
    expect(attributeReferral).toHaveBeenCalledWith(
      "23456789",
      "new-user",
      expect.any(String),
      "scorecard"
    )
  })
})

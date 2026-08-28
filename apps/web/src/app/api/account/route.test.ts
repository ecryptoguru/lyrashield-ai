import { beforeEach, describe, expect, it, vi } from "vitest"

const getSession = vi.fn()

vi.mock("@lyrashield/auth/server", () => ({ getSession }))

const { DELETE } = await import("./route")

describe("DELETE /api/account", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSession.mockResolvedValue({ userId: "user-1" })
  })

  it("requires an authenticated session", async () => {
    getSession.mockResolvedValue(null)
    expect((await DELETE()).status).toBe(401)
  })

  it("fails closed while deletion retention rules require review", async () => {
    const response = await DELETE()

    expect(response.status).toBe(409)
    expect((await response.json()) as unknown).toMatchObject({
      error: {
        code: "ACCOUNT_DELETION_REVIEW_REQUIRED",
        message: expect.stringContaining("support@lyrashieldai.com"),
      },
    })
  })
})

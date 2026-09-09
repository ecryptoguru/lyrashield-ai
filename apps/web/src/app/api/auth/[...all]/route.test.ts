import { beforeEach, describe, expect, it, vi } from "vitest"

const post = vi.hoisted(() => vi.fn())

vi.mock("@lyrashield/auth/server", () => ({ auth: {} }))
vi.mock("better-auth/next-js", () => ({
  toNextJsHandler: () => ({ GET: vi.fn(), POST: post }),
}))

const { POST } = await import("./route")

describe("OAuth route compatibility", () => {
  beforeEach(() => post.mockReset())

  it("normalizes provider rate limits for OAuth clients", async () => {
    post.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Too many requests. Please try again later." }), {
        status: 429,
        headers: { "Retry-After": "60" },
      })
    )

    const response = await POST(
      new Request("https://app.lyrashieldai.com/api/auth/oauth2/token", { method: "POST" })
    )

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("60")
    await expect(response.json()).resolves.toEqual({
      error: "temporarily_unavailable",
      error_description: "Too many requests. Please try again later.",
    })
  })
})

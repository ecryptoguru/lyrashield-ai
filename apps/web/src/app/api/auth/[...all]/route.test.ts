import { beforeEach, describe, expect, it, vi } from "vitest"

const post = vi.hoisted(() => vi.fn())

vi.mock("@lyrashield/auth/server", () => ({ auth: {} }))
vi.mock("better-auth/next-js", () => ({
  toNextJsHandler: () => ({ GET: vi.fn(), POST: post }),
}))

const { POST } = await import("./route")

describe("OAuth route compatibility", () => {
  beforeEach(() => post.mockReset())

  it("forwards omitted-type public loopback clients as native", async () => {
    post.mockResolvedValueOnce(new Response(null, { status: 201 }))

    await POST(
      new Request("https://app.lyrashieldai.com/api/auth/oauth2/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["http://127.0.0.1:19876/mcp/oauth/callback"],
          client_name: "OpenCode",
          token_endpoint_auth_method: "none",
        }),
      })
    )

    const forwarded = post.mock.calls[0]?.[0] as Request
    await expect(forwarded.json()).resolves.toMatchObject({
      application_type: "native",
      token_endpoint_auth_method: "none",
    })
  })

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

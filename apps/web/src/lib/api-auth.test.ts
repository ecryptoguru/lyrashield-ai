import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock("@lyrashield/config", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com" },
}))
vi.mock("@lyrashield/logger", () => ({ setRequestIdResolver: vi.fn() }))
vi.mock("@lyrashield/auth/server", () => ({ getSession: mocks.getSession }))

import { authErrorResponse, getApiRequestId, withApiRequest, withCookieMutation } from "./api-auth"

describe("authErrorResponse", () => {
  it("maps the auth helper markers to their API error contracts", async () => {
    const unauthorized = authErrorResponse(new Error("UNAUTHORIZED"))
    expect(unauthorized?.status).toBe(401)
    expect((await unauthorized!.json()).error.code).toBe("UNAUTHORIZED")

    const forbidden = authErrorResponse(new Error("FORBIDDEN"))
    expect(forbidden?.status).toBe(403)
    expect((await forbidden!.json()).error.code).toBe("FORBIDDEN")

    const reauth = authErrorResponse(new Error("ADMIN_REAUTH_REQUIRED"))
    expect(reauth?.status).toBe(401)
    expect((await reauth!.json()).error.code).toBe("ADMIN_REAUTH_REQUIRED")
  })

  it("returns null for non-auth errors so callers fall through to 500", () => {
    expect(authErrorResponse(new Error("something else"))).toBeNull()
    expect(authErrorResponse("UNAUTHORIZED")).toBeNull()
    expect(authErrorResponse(null)).toBeNull()
  })
})

describe("withApiRequest", () => {
  function observedIdHandler() {
    const seen: { requestId?: string } = {}
    const wrapped = withApiRequest(async (_request: Request) => {
      seen.requestId = getApiRequestId()
      return new Response("ok")
    })
    return { wrapped, seen }
  }

  it("scopes getApiRequestId to the in-flight request and echoes it back", async () => {
    const { wrapped, seen } = observedIdHandler()
    const response = await wrapped(new Request("https://app.lyrashieldai.com"))
    expect(seen.requestId).toBeDefined()
    expect(response.headers.get("x-request-id")).toBe(seen.requestId)
    expect(getApiRequestId()).toBeUndefined()
  })

  it("honours a well-formed upstream x-request-id and ignores a malformed one", async () => {
    const upstream = observedIdHandler()
    await upstream.wrapped(
      new Request("https://app.lyrashieldai.com", {
        headers: { "x-request-id": "req_up-stream-123" },
      })
    )
    expect(upstream.seen.requestId).toBe("req_up-stream-123")

    const malformed = observedIdHandler()
    await malformed.wrapped(
      new Request("https://app.lyrashieldai.com", {
        headers: { "x-request-id": "not a valid id!" },
      })
    )
    expect(malformed.seen.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })
})

describe("withCookieMutation", () => {
  const ok = () => Response.json({ success: true })
  const handler = () => withCookieMutation(async () => ok())

  it("skips the session check entirely for cookie-free requests", async () => {
    const response = await handler()(
      new Request("https://app.lyrashieldai.com", { method: "POST" })
    )
    expect(response.status).toBe(200)
    expect(mocks.getSession).not.toHaveBeenCalled()
  })

  it("applies the same-origin guard to cookie-browser sessions", async () => {
    mocks.getSession.mockResolvedValue({ user: { id: "u" }, apiKey: null, oauth: null })
    const request = new Request("https://app.lyrashieldai.com", {
      method: "POST",
      headers: { cookie: "s=1", origin: "https://evil.example" },
    })
    const response = await handler()(request)
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("FORBIDDEN")
  })

  it("does not guard API-key or OAuth sessions through the browser path", async () => {
    for (const session of [
      { user: { id: "u" }, apiKey: { id: "k" }, oauth: null },
      { user: { id: "u" }, apiKey: null, oauth: { client: "mcp" } },
    ]) {
      mocks.getSession.mockResolvedValue(session)
      const response = await handler()(
        new Request("https://app.lyrashieldai.com", {
          method: "POST",
          headers: { cookie: "s=1", "sec-fetch-site": "cross-site" },
        })
      )
      expect(response.status).toBe(200)
    }
  })
})

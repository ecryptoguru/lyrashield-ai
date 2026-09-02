import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  headers: new Headers(),
  browserSession: vi.fn(),
  apiKey: vi.fn(),
  oauth: vi.fn(),
  setCookie: vi.fn(),
  updateSession: vi.fn(),
}))
vi.mock("next/headers", () => ({
  headers: async () => mocks.headers,
  cookies: async () => ({ set: mocks.setCookie }),
}))
vi.mock("@lyrashield/config", () => ({
  isProd: true,
  env: { NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com", PLATFORM_ADMIN_EMAILS: "" },
}))
vi.mock("../../../../packages/auth/src/auth", () => ({
  auth: { api: { getSession: mocks.browserSession, updateSession: mocks.updateSession } },
}))
vi.mock("../../../../packages/auth/src/oauth", () => ({ verifyOAuthBearer: mocks.oauth }))
vi.mock("@lyrashield/db", () => ({
  verifyApiKey: mocks.apiKey,
  setWorkspaceContext: vi.fn(),
  prisma: {
    user: { findUnique: async () => ({ id: "user", email: "test@example.com", name: "Test" }) },
    workspaceMember: {
      findUnique: async () => ({ id: "member", role: "OWNER", status: "active" }),
    },
  },
}))
// Exercise the real cookie-first / bearer verification boundary, not a mocked session result.
vi.mock("@lyrashield/auth/server", async () => ({
  ...(await import("../../../../packages/auth/src/session")),
  ...(await import("../../../../packages/auth/src/auth")),
}))

import { POST } from "../app/api/workspaces/active/route"
import { assertSameOriginMutation } from "./api-auth"

function request(headers: Record<string, string> = {}) {
  mocks.headers = new Headers({ cookie: "better-auth.session_token=valid", ...headers })
  return new Request("https://app.lyrashieldai.com/api/workspaces/active", {
    method: "POST",
    headers: mocks.headers,
    body: JSON.stringify({ workspaceId: "workspace" }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.browserSession.mockResolvedValue({
    user: { id: "user", email: "test@example.com", name: "Test", image: null },
    session: { id: "session" },
  })
  mocks.apiKey.mockResolvedValue(null)
  mocks.oauth.mockResolvedValue(null)
})

describe("cookie mutation route boundary", () => {
  it.each([undefined, "Bearer forged", "Bearer lsk_forged"])(
    "rejects a cross-origin browser session even with %s",
    async (authorization) => {
      const response = await POST(
        request({ origin: "https://evil.example", ...(authorization ? { authorization } : {}) })
      )
      expect(response.status).toBe(403)
      expect(mocks.setCookie).not.toHaveBeenCalled()
      expect(mocks.updateSession).not.toHaveBeenCalled()
      expect(mocks.apiKey).not.toHaveBeenCalled()
      expect(mocks.oauth).not.toHaveBeenCalled()
    }
  )

  it.each([{ origin: "https://app.lyrashieldai.com" }, { "sec-fetch-site": "same-origin" }])(
    "accepts same-origin browser metadata %j",
    async (headers) => {
      expect((await POST(request(headers))).status).toBe(200)
      expect(mocks.updateSession).toHaveBeenCalledOnce()
    }
  )

  it.each([
    {},
    { origin: "null" },
    { origin: "https://evil.example", "sec-fetch-site": "same-origin" },
    { origin: "https://app.lyrashieldai.com", "sec-fetch-site": "same-site" },
  ])("rejects missing or contradictory metadata %j", async (headers) => {
    expect((await POST(request(headers))).status).toBe(403)
    expect(mocks.setCookie).not.toHaveBeenCalled()
  })

  it("allows a verified write API key with unrelated cookies and no browser origin", async () => {
    mocks.browserSession.mockResolvedValue(null)
    mocks.apiKey.mockResolvedValue({
      keyId: "key",
      workspaceId: "workspace",
      scopes: ["write"],
      createdById: "user",
      prefix: "lsk_test",
    })
    expect(
      (await POST(request({ cookie: "analytics=1", authorization: "Bearer lsk_valid" }))).status
    ).toBe(200)
    expect(mocks.apiKey).toHaveBeenCalledWith("lsk_valid")
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })

  it("allows verified OAuth without requiring browser origin metadata", async () => {
    mocks.browserSession.mockResolvedValue(null)
    mocks.oauth.mockResolvedValue({
      userId: "user",
      workspaceId: "workspace",
      scopes: ["lyrashield.write"],
      sessionId: "oauth:valid",
    })
    expect(
      (await POST(request({ cookie: "analytics=1", authorization: "Bearer oauth-valid" }))).status
    ).toBe(200)
    expect(mocks.oauth).toHaveBeenCalledWith("oauth-valid")
  })

  it("rejects an unverified bearer without a browser session", async () => {
    mocks.browserSession.mockResolvedValue(null)
    expect((await POST(request({ authorization: "Bearer forged" }))).status).toBe(401)
    expect(mocks.setCookie).not.toHaveBeenCalled()
  })

  it.each(["POST", "PUT", "PATCH", "DELETE"])("guards the actual %s method", (method) => {
    expect(() =>
      assertSameOriginMutation(new Request("https://app.lyrashieldai.com", { method }))
    ).toThrow("FORBIDDEN")
  })
  it.each(["GET", "HEAD", "OPTIONS"])("preserves %s reads", (method) => {
    expect(() =>
      assertSameOriginMutation(new Request("https://app.lyrashieldai.com", { method }))
    ).not.toThrow()
  })
})

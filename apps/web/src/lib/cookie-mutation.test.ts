import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  headers: new Headers(),
  browserSession: vi.fn(),
  apiKey: vi.fn(),
  oauth: vi.fn(),
  setCookie: vi.fn(),
  updateSession: vi.fn(),
  mutation: vi.fn(),
  audit: vi.fn(),
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
  lockWorkspaceMembership: vi.fn(),
  withWorkspaceRLS: async (_id: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      workspaceMember: {
        findFirst: async ({ where }: { where: { userId?: string } }) => ({
          role: where.userId ? "OWNER" : "MEMBER",
          userId: where.userId ?? "target-user",
        }),
        updateMany: mocks.mutation,
      },
    }),
  prisma: {
    invitation: { updateMany: mocks.mutation },
    auditLog: { create: mocks.audit },
    user: { findUnique: async () => ({ id: "user", email: "test@example.com", name: "Test" }) },
    workspaceMember: {
      findUnique: async () => ({ id: "member", role: "OWNER", status: "active" }),
    },
  },
}))
vi.mock("@lyrashield/integrations", () => ({ sendNotification: vi.fn() }))
// Exercise the real cookie-first / bearer verification boundary, not a mocked session result.
vi.mock("@lyrashield/auth/server", async () => ({
  ...(await import("../../../../packages/auth/src/session")),
  ...(await import("../../../../packages/auth/src/auth")),
}))

import { POST } from "../app/api/workspaces/active/route"
import { assertSameOriginMutation } from "./api-auth"
import { PATCH as changeRole, DELETE as removeMember } from "../app/api/team/route"
import { DELETE as revokeInvitation } from "../app/api/team/invitations/[id]/route"
import * as canonicalDomain from "../app/api/target-domain-verifications/route"
import * as v1Domain from "../app/api/v1/target-domain-verifications/route"

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
  mocks.mutation.mockResolvedValue({ count: 1 })
})

const teamMutations = [
  {
    name: "change role",
    method: "PATCH",
    path: "/api/team",
    invoke: (req: Request) => changeRole(req),
  },
  {
    name: "remove member",
    method: "DELETE",
    path: "/api/team?workspaceId=workspace&memberId=member",
    invoke: (req: Request) => removeMember(req),
  },
  {
    name: "revoke invitation",
    method: "DELETE",
    path: "/api/team/invitations/invite?workspaceId=workspace",
    invoke: (req: Request) => revokeInvitation(req, { params: Promise.resolve({ id: "invite" }) }),
  },
]

describe.each(teamMutations)("integrated $name cookie boundary", ({ method, path, invoke }) => {
  function mutationRequest(headers: Record<string, string> = {}) {
    mocks.headers = new Headers({ cookie: "better-auth.session_token=valid", ...headers })
    return new Request(`https://app.lyrashieldai.com${path}`, {
      method,
      headers: mocks.headers,
      ...(method === "PATCH"
        ? { body: JSON.stringify({ workspaceId: "workspace", memberId: "member", role: "VIEWER" }) }
        : {}),
    })
  }

  it.each([undefined, "Bearer forged"])(
    "rejects cross-origin cookies with %s before mutation",
    async (authorization) => {
      const response = await invoke(
        mutationRequest({
          origin: "https://evil.example",
          ...(authorization ? { authorization } : {}),
        })
      )
      expect(response.status).toBe(403)
      expect(mocks.mutation).not.toHaveBeenCalled()
      expect(mocks.audit).not.toHaveBeenCalled()
      expect(mocks.apiKey).not.toHaveBeenCalled()
      expect(mocks.oauth).not.toHaveBeenCalled()
    }
  )

  it("allows a same-origin browser request through the normal authorized handler", async () => {
    expect((await invoke(mutationRequest({ origin: "https://app.lyrashieldai.com" }))).status).toBe(
      200
    )
    expect(mocks.mutation).toHaveBeenCalledOnce()
    expect(mocks.audit).toHaveBeenCalledOnce()
  })

  it("allows a verified write API key despite unrelated cookies and cross-origin metadata", async () => {
    mocks.browserSession.mockResolvedValue(null)
    mocks.apiKey.mockResolvedValue({
      keyId: "key",
      workspaceId: "workspace",
      scopes: ["write"],
      createdById: "user",
      prefix: "lsk_test",
    })
    expect(
      (
        await invoke(
          mutationRequest({
            cookie: "analytics=1",
            authorization: "Bearer lsk_valid",
            origin: "https://client.example",
          })
        )
      ).status
    ).toBe(200)
    expect(mocks.apiKey).toHaveBeenCalledWith("lsk_valid")
    expect(mocks.mutation).toHaveBeenCalledOnce()
  })

  it("keeps read-only bearer permission enforcement", async () => {
    mocks.browserSession.mockResolvedValue(null)
    mocks.apiKey.mockResolvedValue({
      keyId: "key",
      workspaceId: "workspace",
      scopes: ["read"],
      createdById: "user",
      prefix: "lsk_test",
    })
    expect((await invoke(mutationRequest({ authorization: "Bearer lsk_read" }))).status).toBe(403)
    expect(mocks.mutation).not.toHaveBeenCalled()
  })

  it("allows verified write OAuth through the existing permission contract", async () => {
    mocks.browserSession.mockResolvedValue(null)
    mocks.oauth.mockResolvedValue({
      userId: "user",
      workspaceId: "workspace",
      scopes: ["lyrashield.write"],
      sessionId: "oauth:valid",
    })
    expect(
      (
        await invoke(
          mutationRequest({
            cookie: "analytics=1",
            authorization: "Bearer oauth-valid",
            origin: "https://client.example",
          })
        )
      ).status
    ).toBe(200)
    expect(mocks.oauth).toHaveBeenCalledWith("oauth-valid")
    expect(mocks.mutation).toHaveBeenCalledOnce()
  })

  it("rejects an unverified bearer when no browser identity exists", async () => {
    mocks.browserSession.mockResolvedValue(null)
    expect((await invoke(mutationRequest({ authorization: "Bearer forged" }))).status).toBe(401)
    expect(mocks.mutation).not.toHaveBeenCalled()
  })
})

it("domain v1 aliases retain canonical guards", async () => {
  expect(v1Domain.POST).toBe(canonicalDomain.POST)
  expect(v1Domain.PUT).toBe(canonicalDomain.PUT)
  for (const [method, handler] of [
    ["POST", v1Domain.POST],
    ["PUT", v1Domain.PUT],
  ] as const) {
    mocks.headers = new Headers({
      cookie: "better-auth.session_token=valid",
      origin: "https://evil.example",
      authorization: "Bearer forged",
    })
    expect(
      (
        await handler(
          new Request("https://app.lyrashieldai.com/api/v1/target-domain-verifications", {
            method,
            headers: mocks.headers,
          })
        )
      ).status
    ).toBe(403)
  }
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

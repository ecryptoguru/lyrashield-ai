import { beforeEach, describe, expect, it, vi } from "vitest"

const headersMock = vi.fn()
vi.mock("next/headers", () => ({ headers: () => headersMock() }))

const getSessionApi = vi.fn()
vi.mock("./auth", () => ({
  auth: { api: { getSession: (...args: unknown[]) => getSessionApi(...args) } },
}))
vi.mock("./oauth", () => ({ verifyOAuthBearer: vi.fn().mockResolvedValue(null) }))
vi.mock("@lyrashield/config", () => ({
  env: { PLATFORM_ADMIN_EMAILS: "ecryptoguru@gmail.com,ankit@lyrashieldai.com" },
}))

const verifyApiKeyMock = vi.fn()
const userFindUnique = vi.fn()
const memberFindUnique = vi.fn()
vi.mock("@lyrashield/db", async () => ({
  CANONICAL_OPERATIONS: (await import("@lyrashield/types")).CANONICAL_OPERATIONS,
  verifyApiKey: (...args: unknown[]) => verifyApiKeyMock(...args),
  setWorkspaceContext: vi.fn(),
  prisma: {
    user: { findUnique: (...args: unknown[]) => userFindUnique(...args) },
    workspaceMember: { findUnique: (...args: unknown[]) => memberFindUnique(...args) },
  },
}))

import {
  assertOAuthDelegatedScope,
  getSession,
  requireWorkspaceAccess,
  requirePermission,
} from "./session"

function withHeaders(map: Record<string, string>) {
  headersMock.mockResolvedValue({
    get: (name: string) => map[name.toLowerCase()] ?? null,
  })
}

import { verifyOAuthBearer } from "./oauth"

const RAW_KEY = `lsk_${"a".repeat(43)}`

function stubVerifiedKey(overrides: Partial<Record<string, unknown>> = {}) {
  verifyApiKeyMock.mockResolvedValue({
    keyId: "key-1",
    workspaceId: "ws-1",
    scopes: ["read"],
    createdById: "user-1",
    prefix: "lsk_aaaaaaaa",
    ...overrides,
  })
  userFindUnique.mockResolvedValue({
    id: "user-1",
    email: "owner@example.com",
    name: "Owner",
    image: null,
  })
}

function stubMembership(role = "OWNER") {
  memberFindUnique.mockResolvedValue({ id: "member-1", role, status: "active" })
}

describe("API key bearer auth", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionApi.mockResolvedValue(null)
    vi.mocked(verifyOAuthBearer).mockResolvedValue(null)
  })

  it.each(["OWNER", "DEVELOPER", "VIEWER", "AUDITOR", "BILLING_ADMIN"])(
    "allows automatic operational writes for active %s members",
    async (role) => {
      withHeaders({ authorization: "Bearer oauth-token" })
      stubVerifiedKey()
      stubMembership(role)
      vi.mocked(verifyOAuthBearer).mockResolvedValue({
        userId: "user-1",
        workspaceId: "ws-1",
        scopes: ["lyrashield.read", "lyrashield.write"],
        connectionId: "conn-1",
        allowedOperations: ["fix_pr.create"],
      })
      await expect(requirePermission("ws-1", "fix:approve")).resolves.toBeTruthy()
      memberFindUnique.mockResolvedValue({ id: "member-1", role, status: "inactive" })
      await expect(requirePermission("ws-1", "fix:approve")).rejects.toThrow("FORBIDDEN")
    }
  )

  it("authenticates a bearer API key when no cookie session exists", async () => {
    withHeaders({ authorization: `Bearer ${RAW_KEY}` })
    stubVerifiedKey()

    const session = await getSession()
    expect(session).not.toBeNull()
    expect(session?.apiKey).toMatchObject({ keyId: "key-1", workspaceId: "ws-1" })
    expect(session?.sessionId).toBe("apikey:key-1")
  })

  it("prefers the cookie session when both are present", async () => {
    withHeaders({ authorization: `Bearer ${RAW_KEY}` })
    getSessionApi.mockResolvedValue({
      user: { id: "cookie-user", email: "c@example.com", name: "Cookie", image: null },
      session: { id: "sess-1" },
    })

    const session = await getSession()
    expect(session?.userId).toBe("cookie-user")
    expect(session?.apiKey).toBeUndefined()
    expect(verifyApiKeyMock).not.toHaveBeenCalled()
  })

  it("ignores non-lsk bearer tokens entirely", async () => {
    withHeaders({ authorization: "Bearer some-jwt-token" })
    expect(await getSession()).toBeNull()
    expect(verifyApiKeyMock).not.toHaveBeenCalled()
  })

  it("returns null when the key's creator no longer exists", async () => {
    withHeaders({ authorization: `Bearer ${RAW_KEY}` })
    stubVerifiedKey()
    userFindUnique.mockResolvedValue(null)
    expect(await getSession()).toBeNull()
  })

  it("binds the key to its own workspace — other workspaces are FORBIDDEN even with membership", async () => {
    withHeaders({ authorization: `Bearer ${RAW_KEY}` })
    stubVerifiedKey({ workspaceId: "ws-1" })
    stubMembership("OWNER")

    await expect(requireWorkspaceAccess("ws-2")).rejects.toThrow("FORBIDDEN")
    // membership lookup must not even run for the foreign workspace
    expect(memberFindUnique).not.toHaveBeenCalled()
  })

  it("allows the key's own workspace", async () => {
    withHeaders({ authorization: `Bearer ${RAW_KEY}` })
    stubVerifiedKey({ workspaceId: "ws-1" })
    stubMembership("OWNER")

    const { session } = await requireWorkspaceAccess("ws-1")
    expect(session.apiKey?.workspaceId).toBe("ws-1")
  })

  it("blocks read-scope keys from mutating permissions but allows reads", async () => {
    withHeaders({ authorization: `Bearer ${RAW_KEY}` })
    stubVerifiedKey({ scopes: ["read"] })
    stubMembership("OWNER")

    await expect(requirePermission("ws-1", "scan:create")).rejects.toThrow("FORBIDDEN")

    stubVerifiedKey({ scopes: ["read"] })
    await expect(requirePermission("ws-1", "scan:view")).resolves.toBeTruthy()
  })

  it("allows write-scope keys to exercise mutating permissions (role permitting)", async () => {
    withHeaders({ authorization: `Bearer ${RAW_KEY}` })
    stubVerifiedKey({ scopes: ["read", "write"] })
    stubMembership("OWNER")

    await expect(requirePermission("ws-1", "scan:create")).resolves.toBeTruthy()
  })
})

describe("OAuth delegated scope", () => {
  const baseSession = {
    userId: "user-1",
    email: "owner@example.com",
    name: "Owner",
    sessionId: "oauth:sess-1",
    oauth: {
      workspaceId: "ws-1",
      userId: "user-1",
      scopes: ["lyrashield.read", "lyrashield.write"],
      connectionId: "conn-1",
      authorizationVersion: 1,
      allowedOperations: ["scan.run"],
      allowedTargetIds: ["target-1"],
      allTargets: false,
      allowedProfiles: ["STANDARD"],
    },
  }

  it("allows only an explicitly granted target and profile", () => {
    expect(() => assertOAuthDelegatedScope(baseSession, "target-1", "STANDARD")).not.toThrow()
    expect(() => assertOAuthDelegatedScope(baseSession, "target-2", "STANDARD")).toThrow(
      "FORBIDDEN"
    )
    expect(() => assertOAuthDelegatedScope(baseSession, "target-1", "DEEP")).toThrow("FORBIDDEN")
  })

  it("allows any target only when the connection explicitly grants all targets", () => {
    const session = {
      ...baseSession,
      oauth: { ...baseSession.oauth, allowedTargetIds: [], allTargets: true },
    }
    expect(() => assertOAuthDelegatedScope(session, "target-2", "STANDARD")).not.toThrow()
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"

const headersMock = vi.fn()
vi.mock("next/headers", () => ({ headers: () => headersMock() }))

const getSessionApi = vi.fn()
vi.mock("./auth", () => ({
  auth: { api: { getSession: (...args: unknown[]) => getSessionApi(...args) } },
}))

const verifyApiKeyMock = vi.fn()
const userFindUnique = vi.fn()
const memberFindUnique = vi.fn()
vi.mock("@lyrashield/db", () => ({
  verifyApiKey: (...args: unknown[]) => verifyApiKeyMock(...args),
  setWorkspaceContext: vi.fn(),
  prisma: {
    user: { findUnique: (...args: unknown[]) => userFindUnique(...args) },
    workspaceMember: { findUnique: (...args: unknown[]) => memberFindUnique(...args) },
  },
}))

import { getSession, requireWorkspaceAccess, requirePermission } from "./session"

function withHeaders(map: Record<string, string>) {
  headersMock.mockResolvedValue({
    get: (name: string) => map[name.toLowerCase()] ?? null,
  })
}

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
  })

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

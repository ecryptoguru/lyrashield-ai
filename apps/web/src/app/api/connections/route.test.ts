import { beforeEach, describe, expect, it, vi } from "vitest"

const updateSessionMock = vi.fn()

vi.mock("@lyrashield/db", () => ({
  CANONICAL_OPERATIONS: {
    SCAN_CREATE: "scan.create",
    REPORT_CREATE: "report.create",
    FIX_PROPOSAL_CREATE: "fix_proposal.create",
    RETEST_CREATE: "retest.create",
    FIX_PR_CREATE: "fix_pr.create",
  },
  createAgentConnection: vi.fn(),
  listAgentConnections: vi.fn(),
  resolveOAuthClientDisplayName: vi.fn(
    (client: { name?: string }) => client.name ?? "Connected coding agent"
  ),
  prisma: {
    auditLog: { create: vi.fn() },
    target: { count: vi.fn() },
    oauthClient: { findUnique: vi.fn() },
  },
}))

const requireWorkspaceAccess = vi.fn()
vi.mock("@lyrashield/auth/server", () => ({
  auth: { api: { updateSession: (...args: unknown[]) => updateSessionMock(...args) } },
  requireWorkspaceAccess: (...args: unknown[]) => requireWorkspaceAccess(...args),
}))

const requireBrowserConnectionManager = vi.fn()
vi.mock("./connection-auth", () => ({
  requireBrowserConnectionManager: (...args: unknown[]) => requireBrowserConnectionManager(...args),
}))

vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn() },
}))

const verifyOAuthConsentState = vi.fn()
const connectionGrantMatchesConsent = vi.fn()
vi.mock("../../../lib/oauth-consent-state", () => ({
  verifyOAuthConsentState: (...args: unknown[]) => verifyOAuthConsentState(...args),
  connectionGrantMatchesConsent: (...args: unknown[]) => connectionGrantMatchesConsent(...args),
}))

import { createAgentConnection, listAgentConnections, prisma } from "@lyrashield/db"
import { GET, POST } from "./route"

function sessionResult(overrides: Record<string, unknown> = {}) {
  return {
    session: { userId: "user-1", ...overrides },
    workspace: { role: "DEVELOPER" },
  }
}

function validConsent() {
  verifyOAuthConsentState.mockReturnValue({
    valid: true,
    payload: {
      clientId: "client-cursor",
      scopes: ["lyrashield.read", "lyrashield.write"],
      userId: "user-1",
      nonce: "n",
      exp: Date.now() + 60_000,
    },
  })
  connectionGrantMatchesConsent.mockReturnValue(true)
}

describe("GET /api/connections", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireWorkspaceAccess.mockResolvedValue(sessionResult())
    requireBrowserConnectionManager.mockResolvedValue(sessionResult())
  })

  it("requires workspaceId", async () => {
    const res = await GET(new Request("http://localhost/api/connections"))
    expect(res.status).toBe(400)
  })

  it("requires active membership and lists connections", async () => {
    vi.mocked(listAgentConnections).mockResolvedValue([
      {
        id: "conn-1",
        workspaceId: "ws-1",
        userId: "user-1",
        clientType: "codex",
        clientName: "Codex Agent",
        status: "ACTIVE",
        scopes: [],
        allowedTargetIds: [],
        allowedOperations: ["CANONICAL_RUN_PR_SCAN"],
        allowedProfiles: ["SAFE", "QUICK", "STANDARD"],
        authorizationVersion: 1,
        expiresAt: null,
        revokedAt: null,
        pausedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    const res = await GET(new Request("http://localhost/api/connections?workspaceId=ws-1"))
    expect(requireWorkspaceAccess).toHaveBeenCalledWith("ws-1")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe("conn-1")
  })
})

describe("POST /api/connections", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireWorkspaceAccess.mockResolvedValue(sessionResult())
    requireBrowserConnectionManager.mockResolvedValue(sessionResult())
    vi.mocked(prisma.target.count).mockResolvedValue(1)
    vi.mocked(prisma.oauthClient.findUnique).mockResolvedValue({ name: "Cursor IDE" } as never)
    validConsent()
  })

  it("creates a connection, binds it to the session, and records audit log", async () => {
    vi.mocked(createAgentConnection).mockResolvedValue({
      id: "conn-new",
      workspaceId: "ws-1",
      userId: "user-1",
      clientType: "cursor",
      clientName: "Cursor IDE",
      oauthClientId: "client-cursor",
      status: "ACTIVE",
      scopes: ["lyrashield.read", "lyrashield.write"],
      allowedTargetIds: ["target-1"],
      allTargets: false,
      allowedOperations: ["scan.create"],
      allowedProfiles: ["SAFE", "QUICK", "STANDARD"],
      authorizationVersion: 1,
      expiresAt: null,
      revokedAt: null,
      pausedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const res = await POST(
      new Request("http://localhost/api/connections", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          clientType: "cursor",
          clientName: "Cursor IDE",
          oauthClientId: "client-cursor",
          scopes: ["lyrashield.read", "lyrashield.write"],
          allowedOperations: ["scan.create"],
          allowedTargetIds: ["target-1"],
          allTargets: false,
          allowedProfiles: ["SAFE"],
          consentState: "signed-state",
        }),
      })
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.id).toBe("conn-new")
    expect(verifyOAuthConsentState).toHaveBeenCalledWith("signed-state")
    expect(createAgentConnection).toHaveBeenCalledWith(
      expect.objectContaining({ clientType: "oauth:client-cursor", clientName: "Cursor IDE" })
    )
    expect(updateSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { activeWorkspaceId: "ws-1", pendingAgentConnectionId: "conn-new" },
      })
    )
    expect(vi.mocked(prisma.auditLog.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "agent_connection.created",
          resourceId: "conn-new",
        }),
      })
    )
  })

  it("uses registered OAuth metadata instead of a client-supplied display name", async () => {
    vi.mocked(createAgentConnection).mockResolvedValue({ id: "conn-new" } as never)

    const res = await POST(
      new Request("http://localhost/api/connections", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          clientType: "Spoofed client",
          clientName: "Spoofed client",
          oauthClientId: "client-cursor",
          scopes: ["lyrashield.read"],
          consentState: "signed-state",
        }),
      })
    )

    expect(res.status).toBe(201)
    expect(createAgentConnection).toHaveBeenCalledWith(
      expect.objectContaining({ clientType: "oauth:client-cursor", clientName: "Cursor IDE" })
    )
  })

  it("rejects a connection when its OAuth client no longer exists", async () => {
    vi.mocked(prisma.oauthClient.findUnique).mockResolvedValue(null)

    const res = await POST(
      new Request("http://localhost/api/connections", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          clientType: "client",
          oauthClientId: "client-cursor",
          scopes: ["lyrashield.read"],
          consentState: "signed-state",
        }),
      })
    )

    expect(res.status).toBe(400)
    expect(createAgentConnection).not.toHaveBeenCalled()
  })

  it("rejects a missing consent state before persisting anything", async () => {
    const res = await POST(
      new Request("http://localhost/api/connections", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          clientType: "cursor",
          oauthClientId: "client-cursor",
          scopes: ["lyrashield.read"],
        }),
      })
    )
    expect(res.status).toBe(400)
    expect(createAgentConnection).not.toHaveBeenCalled()
  })

  it("rejects an invalid consent state", async () => {
    verifyOAuthConsentState.mockReturnValue({ valid: false, reason: "bad_signature" })
    const res = await POST(
      new Request("http://localhost/api/connections", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          clientType: "cursor",
          oauthClientId: "client-cursor",
          scopes: ["lyrashield.read"],
          consentState: "forged.state",
        }),
      })
    )
    expect(res.status).toBe(400)
    expect(createAgentConnection).not.toHaveBeenCalled()
    expect(updateSessionMock).not.toHaveBeenCalled()
  })

  it("rejects a consent state issued for a different session", async () => {
    verifyOAuthConsentState.mockReturnValue({
      valid: true,
      payload: {
        clientId: "client-cursor",
        scopes: ["lyrashield.read"],
        userId: "someone-else",
        nonce: "n",
        exp: Date.now() + 60_000,
      },
    })
    connectionGrantMatchesConsent.mockReturnValue(true)
    const res = await POST(
      new Request("http://localhost/api/connections", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          clientType: "cursor",
          oauthClientId: "client-cursor",
          scopes: ["lyrashield.read"],
          consentState: "signed-for-other-user",
        }),
      })
    )
    expect(res.status).toBe(403)
    expect(createAgentConnection).not.toHaveBeenCalled()
  })

  it("rejects a grant that does not match the authorization request", async () => {
    validConsent()
    connectionGrantMatchesConsent.mockReturnValue(false)
    const res = await POST(
      new Request("http://localhost/api/connections", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          clientType: "cursor",
          oauthClientId: "client-cursor",
          scopes: ["lyrashield.read", "lyrashield.write"],
          allowedOperations: ["scan.create"],
          allTargets: true,
          allowedProfiles: ["SAFE"],
          consentState: "signed-but-mismatched",
        }),
      })
    )
    expect(res.status).toBe(400)
    expect(createAgentConnection).not.toHaveBeenCalled()
    expect(updateSessionMock).not.toHaveBeenCalled()
  })

  it("rejects API key callers", async () => {
    requireBrowserConnectionManager.mockRejectedValue(new Error("FORBIDDEN"))
    const res = await POST(
      new Request("http://localhost/api/connections", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          clientType: "cursor",
          oauthClientId: "client-cursor",
          scopes: ["lyrashield.read"],
          consentState: "signed",
        }),
      })
    )
    expect(res.status).toBe(403)
    expect(createAgentConnection).not.toHaveBeenCalled()
  })

  it("rejects target IDs that are not available in the selected workspace", async () => {
    vi.mocked(prisma.target.count).mockResolvedValue(0)
    const res = await POST(
      new Request("http://localhost/api/connections", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          clientType: "cursor",
          oauthClientId: "client-cursor",
          scopes: ["lyrashield.read", "lyrashield.write"],
          allowedOperations: ["scan.create"],
          allowedTargetIds: ["foreign-target"],
          allowedProfiles: ["SAFE"],
          consentState: "signed",
        }),
      })
    )
    expect(res.status).toBe(400)
    expect(createAgentConnection).not.toHaveBeenCalled()
  })

  it("rejects hidden automation grants on a read-only connection", async () => {
    const res = await POST(
      new Request("http://localhost/api/connections", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          clientType: "cursor",
          oauthClientId: "client-cursor",
          scopes: ["lyrashield.read"],
          allowedOperations: ["report.create"],
          allTargets: true,
          consentState: "signed",
        }),
      })
    )
    expect(res.status).toBe(400)
    expect(createAgentConnection).not.toHaveBeenCalled()
  })

  it("requires an explicit profile for billable delegated workflows", async () => {
    const res = await POST(
      new Request("http://localhost/api/connections", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          clientType: "cursor",
          oauthClientId: "client-cursor",
          scopes: ["lyrashield.read", "lyrashield.write"],
          allowedOperations: ["scan.create"],
          allTargets: true,
          consentState: "signed",
        }),
      })
    )
    expect(res.status).toBe(400)
    expect(createAgentConnection).not.toHaveBeenCalled()
  })

  it("bounds the grant lifetime server-side when expiresAt is omitted", async () => {
    vi.mocked(createAgentConnection).mockResolvedValue({ id: "conn-new" } as never)
    const before = Date.now()

    const res = await POST(
      new Request("http://localhost/api/connections", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          clientType: "cursor",
          oauthClientId: "client-cursor",
          scopes: ["lyrashield.read"],
          consentState: "signed-state",
        }),
      })
    )

    expect(res.status).toBe(201)
    const expiresAt = vi.mocked(createAgentConnection).mock.calls[0]![0].expiresAt
    expect(expiresAt).toBeInstanceOf(Date)
    expect(expiresAt!.getTime() - before).toBeLessThanOrEqual(90 * 86_400_000 + 5_000)
    expect(expiresAt!.getTime()).toBeGreaterThan(before)
  })

  it("rejects a delegated grant expiring beyond the server-side maximum", async () => {
    const res = await POST(
      new Request("http://localhost/api/connections", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          clientType: "cursor",
          oauthClientId: "client-cursor",
          scopes: ["lyrashield.read"],
          expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString(),
          consentState: "signed-state",
        }),
      })
    )

    expect(res.status).toBe(400)
    expect(createAgentConnection).not.toHaveBeenCalled()
  })

  it("rejects a delegated grant expiring in the past", async () => {
    const res = await POST(
      new Request("http://localhost/api/connections", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          clientType: "cursor",
          oauthClientId: "client-cursor",
          scopes: ["lyrashield.read"],
          expiresAt: "2000-01-01T00:00:00.000Z",
          consentState: "signed-state",
        }),
      })
    )

    expect(res.status).toBe(400)
    expect(createAgentConnection).not.toHaveBeenCalled()
  })

  it("accepts a delegated grant expiring inside the maximum lifetime", async () => {
    vi.mocked(createAgentConnection).mockResolvedValue({ id: "conn-new" } as never)
    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString()

    const res = await POST(
      new Request("http://localhost/api/connections", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          clientType: "cursor",
          oauthClientId: "client-cursor",
          scopes: ["lyrashield.read"],
          expiresAt,
          consentState: "signed-state",
        }),
      })
    )

    expect(res.status).toBe(201)
    expect(vi.mocked(createAgentConnection).mock.calls[0]![0].expiresAt).toEqual(new Date(expiresAt))
  })
})

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
  prisma: { auditLog: { create: vi.fn() }, target: { count: vi.fn() } },
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

vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { createAgentConnection, listAgentConnections, prisma } from "@lyrashield/db"
import { GET, POST } from "./route"

function sessionResult(overrides: Record<string, unknown> = {}) {
  return {
    session: { userId: "user-1", ...overrides },
    workspace: { role: "DEVELOPER" },
  }
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

  it("requires DEVELOPER and lists connections", async () => {
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
    expect(requireWorkspaceAccess).toHaveBeenCalledWith("ws-1", "DEVELOPER")
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
        }),
      })
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.id).toBe("conn-new")
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
        }),
      })
    )
    expect(res.status).toBe(400)
    expect(createAgentConnection).not.toHaveBeenCalled()
  })
})

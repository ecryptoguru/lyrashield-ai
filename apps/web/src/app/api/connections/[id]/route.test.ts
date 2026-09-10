import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  getAgentConnection: vi.fn(),
  revokeAgentConnection: vi.fn(),
  pauseAgentConnection: vi.fn(),
  resumeAgentConnection: vi.fn(),
  prisma: { auditLog: { create: vi.fn() } },
}))

const requireWorkspaceAccess = vi.fn()
vi.mock("@lyrashield/auth/server", () => ({
  requireWorkspaceAccess: (...args: unknown[]) => requireWorkspaceAccess(...args),
}))

const requireBrowserConnectionManager = vi.fn()
vi.mock("../connection-auth", () => ({
  requireBrowserConnectionManager: (...args: unknown[]) => requireBrowserConnectionManager(...args),
}))

vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn() },
}))

import {
  getAgentConnection,
  revokeAgentConnection,
  pauseAgentConnection,
  resumeAgentConnection,
  prisma,
  type AgentConnection,
} from "@lyrashield/db"
import { GET, DELETE } from "./route"
import { POST as pausePost } from "./pause/route"
import { POST as resumePost } from "./resume/route"
import { POST as revokePost } from "./revoke/route"

function mockConnection(overrides: Partial<AgentConnection> = {}): AgentConnection {
  return {
    id: "conn-1",
    workspaceId: "ws-1",
    userId: "user-1",
    name: "Connection",
    clientType: "cli",
    status: "ACTIVE",
    authorizationVersion: 1,
    allowedOperations: [],
    allowedTargetIds: [],
    allowedProfiles: [],
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    revokedAt: null,
    pausedAt: null,
    lastUsedAt: null,
    ...overrides,
  }
}

function sessionResult(overrides: Record<string, unknown> = {}) {
  return {
    session: { userId: "user-1", ...overrides },
    workspace: { role: "DEVELOPER" },
  }
}

describe("GET /api/connections/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireWorkspaceAccess.mockResolvedValue(sessionResult())
    requireBrowserConnectionManager.mockResolvedValue({
      ...sessionResult(),
      connection: mockConnection(),
    })
  })

  it("returns connection details by id", async () => {
    vi.mocked(getAgentConnection).mockResolvedValueOnce({
      id: "conn-1",
      workspaceId: "ws-1",
      userId: "user-1",
      clientType: "codex",
      clientName: "Codex",
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
    })

    const res = await GET(new Request("http://localhost/api/connections/conn-1?workspaceId=ws-1"), {
      params: Promise.resolve({ id: "conn-1" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe("conn-1")
  })

  it("returns 404 when connection does not exist", async () => {
    vi.mocked(getAgentConnection).mockResolvedValueOnce(null)
    const res = await GET(
      new Request("http://localhost/api/connections/conn-missing?workspaceId=ws-1"),
      {
        params: Promise.resolve({ id: "conn-missing" }),
      }
    )
    expect(res.status).toBe(404)
  })
})

describe("Lifecycle: Pause, Resume, Revoke & Delete", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireWorkspaceAccess.mockResolvedValue(sessionResult())
    requireBrowserConnectionManager.mockResolvedValue({
      ...sessionResult(),
      connection: mockConnection(),
    })
  })

  it("pauses connection", async () => {
    vi.mocked(pauseAgentConnection).mockResolvedValueOnce(
      mockConnection({ id: "conn-1", status: "PAUSED" })
    )

    const res = await pausePost(
      new Request("http://localhost/api/connections/conn-1/pause", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "ws-1" }),
      }),
      { params: Promise.resolve({ id: "conn-1" }) }
    )
    expect(res.status).toBe(200)
    expect(vi.mocked(prisma.auditLog.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "agent_connection.paused", resourceId: "conn-1" }),
      })
    )
  })

  it("resumes connection", async () => {
    vi.mocked(resumeAgentConnection).mockResolvedValueOnce(
      mockConnection({ id: "conn-1", status: "ACTIVE" })
    )

    const res = await resumePost(
      new Request("http://localhost/api/connections/conn-1/resume", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "ws-1" }),
      }),
      { params: Promise.resolve({ id: "conn-1" }) }
    )
    expect(res.status).toBe(200)
    expect(vi.mocked(prisma.auditLog.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "agent_connection.resumed", resourceId: "conn-1" }),
      })
    )
  })

  it("revokes connection via POST /revoke", async () => {
    vi.mocked(revokeAgentConnection).mockResolvedValueOnce(
      mockConnection({ id: "conn-1", status: "REVOKED" })
    )

    const res = await revokePost(
      new Request("http://localhost/api/connections/conn-1/revoke", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "ws-1" }),
      }),
      { params: Promise.resolve({ id: "conn-1" }) }
    )
    expect(res.status).toBe(200)
    expect(vi.mocked(prisma.auditLog.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "agent_connection.revoked", resourceId: "conn-1" }),
      })
    )
  })

  it("revokes connection via DELETE /[id]", async () => {
    vi.mocked(revokeAgentConnection).mockResolvedValueOnce(
      mockConnection({ id: "conn-1", status: "REVOKED" })
    )

    const res = await DELETE(
      new Request("http://localhost/api/connections/conn-1?workspaceId=ws-1", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "conn-1" }) }
    )
    expect(res.status).toBe(200)
    expect(vi.mocked(prisma.auditLog.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "agent_connection.revoked", resourceId: "conn-1" }),
      })
    )
  })
})

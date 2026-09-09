import { beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "../client"
import {
  listAgentConnections,
  resolveOAuthClientDisplayName,
  resumeAgentConnection,
} from "../agent-connection-service"

vi.mock("../client", () => ({
  prisma: {
    agentConnection: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    oauthClient: { findMany: vi.fn() },
  },
}))

vi.mock("../rls", () => ({
  withWorkspaceRLS: (_workspaceId: string, callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
}))

describe("agent connection lifecycle", () => {
  beforeEach(() => vi.clearAllMocks())

  it("resumes only a still-paused connection so a concurrent revoke cannot be overwritten", async () => {
    vi.mocked(prisma.agentConnection.updateMany).mockResolvedValueOnce({ count: 0 })

    await expect(resumeAgentConnection("conn-1", "ws-1")).resolves.toBeNull()

    expect(prisma.agentConnection.updateMany).toHaveBeenCalledWith({
      where: { id: "conn-1", workspaceId: "ws-1", status: "PAUSED" },
      data: { status: "ACTIVE", pausedAt: null },
    })
    expect(prisma.agentConnection.findUnique).not.toHaveBeenCalled()
  })

  it("shows the registered OAuth client name for existing connections", async () => {
    vi.mocked(prisma.agentConnection.findMany).mockResolvedValue([
      {
        id: "conn-1",
        workspaceId: "ws-1",
        userId: "user-1",
        clientType: "LyraShield AI",
        clientName: "LyraShield AI",
        oauthClientId: "client-opencode",
        status: "ACTIVE",
        scopes: ["lyrashield.read"],
        allowedTargetIds: [],
        allTargets: false,
        allowedOperations: [],
        allowedProfiles: [],
        authorizationVersion: 1,
        expiresAt: null,
        revokedAt: null,
        pausedAt: null,
        createdAt: new Date("2026-09-10T00:00:00Z"),
        updatedAt: new Date("2026-09-10T00:00:00Z"),
        operations: [],
      },
    ] as never)
    vi.mocked(prisma.oauthClient.findMany).mockResolvedValue([
      { clientId: "client-opencode", name: "OpenCode" },
    ] as never)

    const [connection] = await listAgentConnections("ws-1")

    expect(connection?.clientName).toBe("OpenCode")
  })

  it("identifies hosted clients when dynamic registration uses a generic server name", () => {
    expect(
      resolveOAuthClientDisplayName({
        name: "LyraShield AI",
        redirectUris: ["https://api.devin.ai/mcp/oauth/callback"],
      })
    ).toBe("Devin")
    expect(
      resolveOAuthClientDisplayName({
        name: "LyraShield AI",
        redirectUris: ["https://antigravity.google/oauth-callback"],
      })
    ).toBe("Antigravity")
    expect(
      resolveOAuthClientDisplayName({
        name: "LyraShield AI",
        redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      })
    ).toBe("Claude")
  })
})

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./auth", () => ({
  auth: { api: { getSession: vi.fn() } },
  OAUTH_ISSUER: "http://localhost:3000/api/auth",
  OAUTH_RESOURCE: "http://localhost:3000/api/mcp",
  OAUTH_SCOPE_READ: "lyrashield.read",
  OAUTH_SCOPE_WRITE: "lyrashield.write",
  OAUTH_WORKSPACE_CLAIM: "https://lyrashieldai.com/workspace_id",
  OAUTH_CONNECTION_CLAIM: "https://lyrashieldai.com/connection_id",
  OAUTH_AUTH_VERSION_CLAIM: "https://lyrashieldai.com/auth_version",
}))

import { verifyOAuthBearer } from "./oauth"
import { prisma, type AgentConnection, AgentConnectionStatus } from "@lyrashield/db"

const verifyBearerTokenMock = vi.fn()

vi.mock("@better-auth/oauth-provider/resource-client", () => ({
  oauthProviderResourceClient: () => ({
    getActions: () => ({
      verifyBearerToken: (...args: unknown[]) => verifyBearerTokenMock(...args),
    }),
  }),
}))

vi.mock("@lyrashield/db", () => {
  const mockPrisma = {
    agentConnection: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  }
  return {
    prisma: mockPrisma,
    withWorkspaceRLS: (_workspaceId: string, callback: (tx: typeof mockPrisma) => unknown) =>
      callback(mockPrisma),
    AgentConnectionStatus: {
      ACTIVE: "ACTIVE",
      PAUSED: "PAUSED",
      REVOKED: "REVOKED",
    },
  }
})

function buildMockConnection(overrides: Partial<AgentConnection> = {}): AgentConnection {
  return {
    id: "conn_456",
    workspaceId: "ws_123",
    userId: "user_123",
    name: "Test Connection",
    clientType: "CLI",
    clientName: "Test Connection",
    oauthClientId: "client_codex",
    status: AgentConnectionStatus.ACTIVE,
    scopes: ["lyrashield.read", "lyrashield.write"],
    authorizationVersion: 1,
    allowedOperations: ["CANONICAL_RUN_PR_SCAN"],
    allowedTargetIds: ["target_1"],
    allTargets: false,
    allowedProfiles: ["STANDARD"],
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    revokedAt: null,
    pausedAt: null,
    lastUsedAt: null,
    ...overrides,
  }
}

describe("OAuth Connection Binding & Immediate Revocation Barrier", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("verifies and returns active connection context when claims and DB status match", async () => {
    verifyBearerTokenMock.mockResolvedValueOnce({
      sub: "user_123",
      "https://lyrashieldai.com/workspace_id": "ws_123",
      "https://lyrashieldai.com/connection_id": "conn_456",
      "https://lyrashieldai.com/auth_version": 1,
      scope: "lyrashield.read lyrashield.write",
      azp: "client_codex",
      sid: "sess_789",
    })

    vi.mocked(prisma.agentConnection.findUnique).mockResolvedValueOnce(buildMockConnection())

    const result = await verifyOAuthBearer("valid_signed_token")
    expect(result).not.toBeNull()
    expect(result?.userId).toBe("user_123")
    expect(result?.workspaceId).toBe("ws_123")
    expect(result?.connectionId).toBe("conn_456")
    expect(result?.authorizationVersion).toBe(1)
    expect(result?.allowedOperations).toEqual(["CANONICAL_RUN_PR_SCAN"])
    expect(result?.allowedTargetIds).toEqual(["target_1"])
  })

  it("immediately rejects token when connection is REVOKED even if JWT signature is valid", async () => {
    verifyBearerTokenMock.mockResolvedValueOnce({
      sub: "user_123",
      "https://lyrashieldai.com/workspace_id": "ws_123",
      "https://lyrashieldai.com/connection_id": "conn_456",
      "https://lyrashieldai.com/auth_version": 1,
      scope: "lyrashield.read lyrashield.write",
    })

    vi.mocked(prisma.agentConnection.findUnique).mockResolvedValueOnce(
      buildMockConnection({
        status: AgentConnectionStatus.REVOKED,
        authorizationVersion: 2,
        allowedTargetIds: [],
        allowedProfiles: [],
      })
    )

    const result = await verifyOAuthBearer("valid_signed_token_for_revoked_conn")
    expect(result).toBeNull()
  })

  it("immediately rejects token when connection is PAUSED even if JWT signature is valid", async () => {
    verifyBearerTokenMock.mockResolvedValueOnce({
      sub: "user_123",
      "https://lyrashieldai.com/workspace_id": "ws_123",
      "https://lyrashieldai.com/connection_id": "conn_456",
      "https://lyrashieldai.com/auth_version": 1,
      scope: "lyrashield.read lyrashield.write",
    })

    vi.mocked(prisma.agentConnection.findUnique).mockResolvedValueOnce(
      buildMockConnection({
        status: AgentConnectionStatus.PAUSED,
        allowedTargetIds: [],
        allowedProfiles: [],
      })
    )

    const result = await verifyOAuthBearer("valid_signed_token_for_paused_conn")
    expect(result).toBeNull()
  })

  it("immediately rejects token when authorizationVersion in token does not match DB version", async () => {
    verifyBearerTokenMock.mockResolvedValueOnce({
      sub: "user_123",
      "https://lyrashieldai.com/workspace_id": "ws_123",
      "https://lyrashieldai.com/connection_id": "conn_456",
      "https://lyrashieldai.com/auth_version": 1,
      scope: "lyrashield.read lyrashield.write",
    })

    vi.mocked(prisma.agentConnection.findUnique).mockResolvedValueOnce(
      buildMockConnection({
        authorizationVersion: 2, // version was bumped
        allowedTargetIds: [],
        allowedProfiles: [],
      })
    )

    const result = await verifyOAuthBearer("stale_version_token")
    expect(result).toBeNull()
  })

  it("rejects a connection token without its authorization version claim", async () => {
    verifyBearerTokenMock.mockResolvedValueOnce({
      sub: "user_123",
      "https://lyrashieldai.com/workspace_id": "ws_123",
      "https://lyrashieldai.com/connection_id": "conn_456",
      scope: "lyrashield.read lyrashield.write",
      azp: "client_codex",
    })
    vi.mocked(prisma.agentConnection.findUnique).mockResolvedValueOnce(buildMockConnection())

    await expect(verifyOAuthBearer("missing_version_token")).resolves.toBeNull()
  })

  it("rejects a connection token issued to a different OAuth client", async () => {
    verifyBearerTokenMock.mockResolvedValueOnce({
      sub: "user_123",
      "https://lyrashieldai.com/workspace_id": "ws_123",
      "https://lyrashieldai.com/connection_id": "conn_456",
      "https://lyrashieldai.com/auth_version": 1,
      scope: "lyrashield.read lyrashield.write",
      azp: "client_other",
    })
    vi.mocked(prisma.agentConnection.findUnique).mockResolvedValueOnce(buildMockConnection())

    await expect(verifyOAuthBearer("wrong_client_token")).resolves.toBeNull()
  })

  it("immediately rejects token when connection is expired", async () => {
    verifyBearerTokenMock.mockResolvedValueOnce({
      sub: "user_123",
      "https://lyrashieldai.com/workspace_id": "ws_123",
      "https://lyrashieldai.com/connection_id": "conn_456",
      "https://lyrashieldai.com/auth_version": 1,
      scope: "lyrashield.read lyrashield.write",
    })

    vi.mocked(prisma.agentConnection.findUnique).mockResolvedValueOnce(
      buildMockConnection({
        allowedTargetIds: [],
        allowedProfiles: [],
        expiresAt: new Date(Date.now() - 60_000), // expired 1 min ago
      })
    )

    const result = await verifyOAuthBearer("expired_conn_token")
    expect(result).toBeNull()
  })

  it("accepts legacy tokens without connectionId claim (preserving reviewed mode)", async () => {
    verifyBearerTokenMock.mockResolvedValueOnce({
      sub: "user_123",
      "https://lyrashieldai.com/workspace_id": "ws_123",
      scope: "lyrashield.read lyrashield.write",
      azp: "legacy_client",
    })

    const result = await verifyOAuthBearer("legacy_token")
    expect(result).not.toBeNull()
    expect(result?.userId).toBe("user_123")
    expect(result?.workspaceId).toBe("ws_123")
    expect(result?.connectionId).toBeUndefined()
  })
})

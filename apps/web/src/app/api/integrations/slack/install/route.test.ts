import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const {
  exchangeSlackOAuthCode,
  getSlackAuthorizeUrl,
  upsertConnectorConnection,
  uploadEncryptedArtifact,
  auditLogCreate,
  integrationFindFirst,
  requirePermission,
  verifyInstallState,
} = vi.hoisted(() => ({
  exchangeSlackOAuthCode: vi.fn(),
  getSlackAuthorizeUrl: vi.fn(),
  upsertConnectorConnection: vi.fn(),
  uploadEncryptedArtifact: vi.fn(),
  auditLogCreate: vi.fn(),
  integrationFindFirst: vi.fn(),
  requirePermission: vi.fn(),
  verifyInstallState: vi.fn(),
}))

vi.mock("../../../../../lib/api-auth", () => ({
  withCookieMutation: (handler: unknown) => handler,
  authErrorResponse: vi.fn(() => null),
}))

vi.mock("@lyrashield/config", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.test", BETTER_AUTH_URL: "https://app.test" },
}))

vi.mock("@lyrashield/db", () => ({
  prisma: {
    integration: { findFirst: integrationFindFirst },
    auditLog: { create: auditLogCreate },
  },
  upsertConnectorConnection,
  ConnectorConnectionError: class ConnectorConnectionError extends Error {
    code: string
    constructor(message: string, code: string) {
      super(message)
      this.code = code
    }
  },
}))

vi.mock("@lyrashield/auth/server", () => ({
  getSession: vi.fn(async () => ({ userId: "user-1" })),
  requirePermission,
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { integration: { manage: "integration:manage" } },
}))

vi.mock("@lyrashield/integrations", () => ({
  exchangeSlackOAuthCode,
  getSlackAuthorizeUrl,
  SLACK_CONNECT_SCOPES: ["channels:read", "channels:history", "team:read", "users:read"],
}))

vi.mock("@lyrashield/evidence-storage", () => ({
  uploadEncryptedArtifact,
}))

vi.mock("@lyrashield/logger", async () =>
  (await import("../../../../../__tests__/mocks")).loggerModule()
)

vi.mock("../../../../../lib/github-install-state", () => ({
  createInstallState: vi.fn(() => "signed-state"),
  verifyInstallState,
}))

import { GET } from "./route"

function callback(query: string): NextRequest {
  return new NextRequest(`https://app.test/api/integrations/slack/install?${query}`)
}

describe("GET /api/integrations/slack/install", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyInstallState.mockReturnValue({
      valid: true,
      workspaceId: "ws-1",
      returnTo: "integrations",
    })
    requirePermission.mockResolvedValue({
      session: { userId: "user-1" },
      workspace: { id: "ws-1" },
    })
    uploadEncryptedArtifact.mockResolvedValue({ storageUri: "vault://slack-token" })
    upsertConnectorConnection.mockResolvedValue({ id: "int-1" })
    auditLogCreate.mockResolvedValue({})
  })

  it.each([
    ["absent", null],
    ["blank", "   "],
  ])(
    "rejects an OAuth grant whose scope is %s instead of substituting the requested list",
    async (_label, scope) => {
      exchangeSlackOAuthCode.mockResolvedValue({
        accessToken: "xoxb-token",
        teamId: "T1",
        teamName: "Acme",
        scope,
        botUserId: "U1",
      })

      const res = await GET(callback("code=c1&state=signed-state"))
      expect(res.status).toBe(307)
      const location = res.headers.get("location") ?? ""
      expect(location).toContain("/dashboard/integrations")
      expect(location).toContain("slack=missing_scopes")
      // Nothing may be sealed or persisted for a grant that reports no scopes.
      expect(uploadEncryptedArtifact).not.toHaveBeenCalled()
      expect(upsertConnectorConnection).not.toHaveBeenCalled()
    }
  )

  it("records exactly the granted scopes — never the requested list", async () => {
    exchangeSlackOAuthCode.mockResolvedValue({
      accessToken: "xoxb-token",
      teamId: "T1",
      teamName: "Acme",
      scope: "channels:read,team:read",
      botUserId: "U1",
    })

    const res = await GET(callback("code=c1&state=signed-state"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("connected=slack")
    expect(upsertConnectorConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "slack",
        externalId: "T1",
        capabilities: { scopes: ["channels:read", "team:read"] },
      })
    )
  })
})

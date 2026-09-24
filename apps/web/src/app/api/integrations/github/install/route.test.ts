import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const {
  getAppInstallations,
  exchangeInstallUserCode,
  userCanAdminInstallation,
  listInstallationRepos,
  integrationFindFirst,
  integrationCreate,
  integrationUpdate,
  auditLogCreate,
  requirePermission,
  verifyInstallState,
} = vi.hoisted(() => ({
  getAppInstallations: vi.fn(),
  exchangeInstallUserCode: vi.fn(),
  userCanAdminInstallation: vi.fn(),
  listInstallationRepos: vi.fn(),
  integrationFindFirst: vi.fn(),
  integrationCreate: vi.fn(),
  integrationUpdate: vi.fn(),
  auditLogCreate: vi.fn(),
  requirePermission: vi.fn(),
  verifyInstallState: vi.fn(),
}))

vi.mock("../../../../../lib/api-auth", () => ({
  withCookieMutation: (handler: unknown) => handler,
  authErrorResponse: vi.fn(() => null),
}))

vi.mock("@/lib/oauth-onboarding-return", () => ({
  verifyOAuthOnboardingReturn: vi.fn(() => ({ valid: false, reason: "malformed" })),
}))

vi.mock("@lyrashield/config", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.test", BETTER_AUTH_URL: "https://app.test" },
}))

vi.mock("@lyrashield/db", () => ({
  prisma: {
    integration: {
      findFirst: integrationFindFirst,
      create: integrationCreate,
      update: integrationUpdate,
    },
    auditLog: { create: auditLogCreate },
  },
}))

vi.mock("@lyrashield/auth/server", () => ({
  getSession: vi.fn(async () => ({ userId: "user-1" })),
  requirePermission,
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { integration: { manage: "integration:manage" } },
}))

vi.mock("@lyrashield/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/integrations")>()
  return {
    ...actual,
    getInstallAppUrl: vi.fn(() => "https://github.com/apps/test-app/installations/new"),
    getAppInstallations,
    exchangeInstallUserCode,
    userCanAdminInstallation,
    listInstallationRepos,
  }
})

vi.mock("@lyrashield/logger", async () =>
  (await import("../../../../../__tests__/mocks")).loggerModule()
)

vi.mock("../../../../../lib/github-install-state", () => ({
  createInstallState: vi.fn(() => "signed-state"),
  verifyInstallState,
}))

import { GET } from "./route"

const INSTALLATION_ID = "777"

function callback(extra = ""): NextRequest {
  return new NextRequest(
    `https://app.test/api/integrations/github/install?installation_id=${INSTALLATION_ID}&state=signed-state&setup_action=install${extra}`
  )
}

function installation(overrides: Record<string, unknown> = {}) {
  return {
    id: Number(INSTALLATION_ID),
    account: { login: "acme", id: 42, type: "Organization" },
    permissions: { metadata: "read", contents: "read", pull_requests: "read", issues: "read" },
    repository_selection: "selected",
    ...overrides,
  }
}

describe("GET /api/integrations/github/install", () => {
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
    getAppInstallations.mockResolvedValue([installation()])
    integrationFindFirst.mockResolvedValue(null)
    exchangeInstallUserCode.mockResolvedValue("user-token")
    userCanAdminInstallation.mockResolvedValue(true)
    listInstallationRepos.mockResolvedValue([
      { id: 1, full_name: "acme/app" },
      { id: 2, full_name: "acme/api" },
    ])
    integrationCreate.mockResolvedValue({ id: "int-1" })
    integrationUpdate.mockResolvedValue({ id: "int-existing" })
    auditLogCreate.mockResolvedValue({})
  })

  it("records provider-granted scopes and the selected repository list on the grant", async () => {
    const res = await GET(callback("&code=oauth-code"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("connected=github")
    expect(listInstallationRepos).toHaveBeenCalledWith(Number(INSTALLATION_ID))
    expect(integrationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          capabilities: {
            scopes: ["repo:metadata", "repo:contents", "repo:pull_requests", "repo:issues"],
            resources: ["repo:acme/app", "repo:acme/api"],
          },
        }),
      })
    )
  })

  it("leaves resources unconstrained for an all-repositories installation", async () => {
    getAppInstallations.mockResolvedValue([installation({ repository_selection: "all" })])
    const res = await GET(callback("&code=oauth-code"))
    expect(res.status).toBe(307)
    // An "all" install grants every current and future repository at the
    // provider — recording a snapshot would be stale-narrow immediately.
    expect(listInstallationRepos).not.toHaveBeenCalled()
    const data = vi.mocked(integrationCreate).mock.calls[0]?.[0]?.data as {
      capabilities?: { scopes?: string[]; resources?: string[] }
    }
    expect(data.capabilities?.scopes).toContain("repo:metadata")
    expect(data.capabilities).not.toHaveProperty("resources")
  })

  it("re-snapshots the provider's current selection on reconnect", async () => {
    integrationFindFirst.mockResolvedValue({ id: "int-existing", deletedAt: new Date() })
    // The selection changed provider-side since the first connect: acme/api
    // was removed and acme/web was added — the refreshed grant must reflect
    // the provider's list, not the stale stored one.
    listInstallationRepos.mockResolvedValue([{ id: 3, full_name: "acme/web" }])
    const res = await GET(callback())
    expect(res.status).toBe(307)
    expect(integrationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          capabilities: expect.objectContaining({ resources: ["repo:acme/web"] }),
        }),
      })
    )
  })

  it("stores an empty scope list when the installation grants no connector permissions", async () => {
    getAppInstallations.mockResolvedValue([installation({ permissions: {} })])
    const res = await GET(callback("&code=oauth-code"))
    expect(res.status).toBe(307)
    const data = vi.mocked(integrationCreate).mock.calls[0]?.[0]?.data as {
      capabilities?: { scopes?: string[] }
    }
    // Fail closed: no scopes recorded means every tool denies at invocation.
    expect(data.capabilities?.scopes).toEqual([])
  })

  it("does not write the grant when the selected-repo read fails", async () => {
    listInstallationRepos.mockRejectedValue(new Error("provider down"))
    const res = await GET(callback("&code=oauth-code"))
    expect(res.status).toBe(500)
    expect(integrationCreate).not.toHaveBeenCalled()
    expect(integrationUpdate).not.toHaveBeenCalled()
  })
})

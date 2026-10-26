import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const {
  getAppInstallations,
  exchangeInstallUserCode,
  getUserAdminInstallations,
  listInstallationRepos,
  integrationUpsert,
  auditLogCreate,
  requirePermission,
  verifyInstallState,
} = vi.hoisted(() => ({
  getAppInstallations: vi.fn(),
  exchangeInstallUserCode: vi.fn(),
  getUserAdminInstallations: vi.fn(),
  listInstallationRepos: vi.fn(),
  integrationUpsert: vi.fn(),
  auditLogCreate: vi.fn(),
  requirePermission: vi.fn(),
  verifyInstallState: vi.fn(),
}))

vi.mock("../../../../../lib/api-auth", () => ({
  withCookieMutation: (handler: unknown) => handler,
  authErrorResponse: vi.fn((error: unknown) =>
    error instanceof Error && error.message === "FORBIDDEN"
      ? Response.json({ success: false, error: { code: "FORBIDDEN" } }, { status: 403 })
      : null
  ),
}))

vi.mock("@/lib/oauth-onboarding-return", () => ({
  verifyOAuthOnboardingReturn: vi.fn(() => ({ valid: false, reason: "malformed" })),
}))

vi.mock("@lyrashield/config", () => ({
  env: {
    BETTER_AUTH_SECRET: "synthetic-test-only-secret-at-least-32",
    GITHUB_APP_CLIENT_ID: "test-client",
    NEXT_PUBLIC_APP_URL: "https://app.test",
    BETTER_AUTH_URL: "https://app.test",
  },
}))

vi.mock("@lyrashield/db", () => ({
  withWorkspaceRLS: async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      integration: { findFirst: async () => null, upsert: integrationUpsert },
      $executeRaw: vi.fn(),
    }),
  prisma: {
    integration: {
      upsert: integrationUpsert,
    },
    auditLog: { create: auditLogCreate },
  },
}))

vi.mock("@lyrashield/auth/server", () => ({
  getSession: vi.fn(async () => ({ userId: "user-1", sessionId: "session-1" })),
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
    getUserAdminInstallations,
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

import { createHash } from "node:crypto"
import { GET, POST } from "./route"
import { expectPermissionDenied } from "@/__tests__/route-permission-manifest"

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
      github: {
        purpose: "github-install",
        userId: "user-1",
        sessionHash: createHash("sha256").update("session-1").digest("hex"),
      },
    })
    requirePermission.mockResolvedValue({
      session: { userId: "user-1", sessionId: "session-1" },
      workspace: { id: "ws-1" },
    })
    getAppInstallations.mockResolvedValue([installation()])
    exchangeInstallUserCode.mockResolvedValue("user-token")
    getUserAdminInstallations.mockResolvedValue({
      userId: 42,
      installations: [{ id: 777, login: "acme" }],
    })
    listInstallationRepos.mockResolvedValue([
      { id: 1, full_name: "acme/app" },
      { id: 2, full_name: "acme/api" },
    ])
    integrationUpsert.mockResolvedValue({ id: "int-1" })
    auditLogCreate.mockResolvedValue({})
  })

  it("records provider-granted scopes and the selected repository list on the grant", async () => {
    const res = await GET(callback("&code=oauth-code"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("connected=github")
    expect(listInstallationRepos).toHaveBeenCalledWith(Number(INSTALLATION_ID))
    expect(integrationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          capabilities: {
            scopes: ["repo:metadata", "repo:contents", "repo:pull_requests", "repo:issues"],
            resources: ["repo:acme/app", "repo:acme/api"],
          },
        }),
      })
    )
  })

  it("denies an install callback without integration:manage", async () => {
    requirePermission.mockRejectedValueOnce(new Error("FORBIDDEN"))

    const res = await GET(callback("&code=oauth-code"))

    expectPermissionDenied(
      res,
      requirePermission.mock.calls,
      "ws-1",
      "/api/integrations/github/install",
      "GET"
    )
    expect(getAppInstallations).not.toHaveBeenCalled()
    expect(integrationUpsert).not.toHaveBeenCalled()
  })

  it("denies starting an install without integration:manage", async () => {
    requirePermission.mockRejectedValueOnce(new Error("FORBIDDEN"))
    const request = new NextRequest("https://app.test/api/integrations/github/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-1" }),
    })

    const res = await POST(request)

    expectPermissionDenied(
      res,
      requirePermission.mock.calls,
      "ws-1",
      "/api/integrations/github/install",
      "POST"
    )
    expect(auditLogCreate).not.toHaveBeenCalled()
  })

  it("leaves resources unconstrained for an all-repositories installation", async () => {
    getAppInstallations.mockResolvedValue([installation({ repository_selection: "all" })])
    const res = await GET(callback("&code=oauth-code"))
    expect(res.status).toBe(307)
    // An "all" install grants every current and future repository at the
    // provider — recording a snapshot would be stale-narrow immediately.
    expect(listInstallationRepos).not.toHaveBeenCalled()
    const data = vi.mocked(integrationUpsert).mock.calls[0]?.[0]?.create as {
      capabilities?: { scopes?: string[]; resources?: string[] }
    }
    expect(data.capabilities?.scopes).toContain("repo:metadata")
    expect(data.capabilities).not.toHaveProperty("resources")
  })

  it("re-snapshots the provider's current selection on reconnect", async () => {
    integrationUpsert.mockResolvedValue({ id: "int-existing" })
    // The selection changed provider-side since the first connect: acme/api
    // was removed and acme/web was added — the refreshed grant must reflect
    // the provider's list, not the stale stored one.
    listInstallationRepos.mockResolvedValue([{ id: 3, full_name: "acme/web" }])
    const res = await GET(callback("&code=fresh-code"))
    expect(res.status).toBe(307)
    expect(integrationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_type_externalId: { workspaceId: "ws-1", type: "GITHUB", externalId: "777" },
        },
        update: expect.objectContaining({
          deletedAt: null,
          capabilities: expect.objectContaining({ resources: ["repo:acme/web"] }),
        }),
      })
    )
  })

  it("stores an empty scope list when the installation grants no connector permissions", async () => {
    getAppInstallations.mockResolvedValue([installation({ permissions: {} })])
    const res = await GET(callback("&code=oauth-code"))
    expect(res.status).toBe(307)
    const data = vi.mocked(integrationUpsert).mock.calls[0]?.[0]?.create as {
      capabilities?: { scopes?: string[] }
    }
    // Fail closed: no scopes recorded means every tool denies at invocation.
    expect(data.capabilities?.scopes).toEqual([])
  })

  it("does not write the grant when the selected-repo read fails", async () => {
    listInstallationRepos.mockRejectedValue(new Error("provider down"))
    const res = await GET(callback("&code=oauth-code"))
    expect(res.status).toBe(500)
    expect(integrationUpsert).not.toHaveBeenCalled()
  })
  it("returns a verified GitHub installation directly to first-scan setup", async () => {
    verifyInstallState.mockReturnValue({ ...verifyInstallState(), returnTo: "scan" })
    const response = await GET(callback("&code=oauth-code"))
    expect(response.status).toBe(307)
    const destination = new URL(response.headers.get("location")!)
    expect(destination.pathname).toBe("/dashboard/scans")
    expect(destination.searchParams.get("new")).toBe("1")
    expect(destination.searchParams.get("source")).toBe("repo")
    expect(destination.searchParams.get("connected")).toBe("github")
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "integration:manage")
  })
})

describe("existing installation discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyInstallState.mockReturnValue({
      valid: true,
      workspaceId: "ws-1",
      returnTo: "onboarding",
      github: {
        purpose: "github-discover",
        userId: "user-1",
        sessionHash: createHash("sha256").update("session-1").digest("hex"),
      },
    })
    requirePermission.mockResolvedValue({ session: { userId: "user-1", sessionId: "session-1" } })
    exchangeInstallUserCode.mockResolvedValue("ephemeral-user-token")
    getUserAdminInstallations.mockResolvedValue({
      userId: 42,
      installations: [{ id: 777, login: "acme" }],
    })
    getAppInstallations.mockResolvedValue([installation()])
    integrationUpsert.mockResolvedValue({ id: "int-1" })
    listInstallationRepos.mockResolvedValue([])
  })
  const discover = (extra = "&code=fresh-code") =>
    new NextRequest(`https://app.test/api/integrations/github/install?state=signed-state${extra}`)

  it("starts existing-installation OAuth by default and preserves install-new", async () => {
    for (const [mode, path] of [
      [undefined, "/login/oauth/authorize"],
      ["install-new", "/apps/test-app/installations/new"],
    ]) {
      const response = await POST(
        new NextRequest("https://app.test/api/integrations/github/install", {
          method: "POST",
          body: JSON.stringify({ workspaceId: "ws-1", mode }),
        })
      )
      const url = new URL((await response.json()).data.installUrl)
      expect(url.pathname).toBe(path)
      expect(url.searchParams.get("state")).toBe("signed-state")
    }
  })
  it("binds the single eligible installation without requiring installation_id", async () => {
    expect((await GET(discover())).headers.get("location")).toBe(
      "https://app.test/onboarding?connected=github"
    )
    expect(integrationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ externalId: "777", workspaceId: "ws-1" }),
      })
    )
  })
  it("returns install-new recovery when no installation is eligible", async () => {
    getUserAdminInstallations.mockResolvedValue({ userId: 42, installations: [] })
    expect((await GET(discover())).headers.get("location")).toContain("github=no_installations")
    expect(integrationUpsert).not.toHaveBeenCalled()
  })
  it("redirects multiple candidates to a chooser without binding", async () => {
    getUserAdminInstallations.mockResolvedValue({
      userId: 42,
      installations: [
        { id: 777, login: "acme" },
        { id: 888, login: "other" },
      ],
    })
    getAppInstallations.mockResolvedValue([installation(), installation({ id: 888 })])
    expect((await GET(discover())).headers.get("location")).toContain(
      "/integrations/github/choose?state="
    )
    expect(integrationUpsert).not.toHaveBeenCalled()
  })
  it("rejects changed app sessions before provider exchange", async () => {
    const current = verifyInstallState()
    verifyInstallState.mockReturnValue({
      ...current,
      github: { ...current.github, sessionHash: "b".repeat(64) },
    })
    expect((await GET(discover())).headers.get("location")).toContain("github=session_changed")
    expect(exchangeInstallUserCode).not.toHaveBeenCalled()
    expect(integrationUpsert).not.toHaveBeenCalled()
  })
  it("handles cancellation without a provider call or write", async () => {
    expect((await GET(discover("&error=access_denied"))).headers.get("location")).toContain(
      "github=cancelled"
    )
    expect(exchangeInstallUserCode).not.toHaveBeenCalled()
  })
  it("does not authorize with chooser context", async () => {
    const current = verifyInstallState()
    verifyInstallState.mockReturnValue({
      ...current,
      github: {
        ...current.github,
        purpose: "github-choose",
        providerUserId: 42,
        candidates: [{ id: 777, login: "acme" }],
      },
    })
    expect((await GET(discover())).status).toBe(400)
    expect(exchangeInstallUserCode).not.toHaveBeenCalled()
  })
  it("restarts proof for legacy state, even if a code is present", async () => {
    verifyInstallState.mockReturnValue({ valid: true, workspaceId: "ws-1", returnTo: "onboarding" })
    expect((await GET(discover())).headers.get("location")).toContain(
      "https://github.com/login/oauth/authorize?"
    )
    expect(exchangeInstallUserCode).not.toHaveBeenCalled()
    expect(integrationUpsert).not.toHaveBeenCalled()
  })
  it("returns already_claimed on uniqueness races without transferring a grant", async () => {
    integrationUpsert.mockRejectedValueOnce({ code: "P2002" })
    expect((await GET(discover())).headers.get("location")).toContain("github=already_claimed")
  })
})

describe("fresh proof after chooser selection", () => {
  const identity = {
    userId: "user-1",
    sessionHash: createHash("sha256").update("session-1").digest("hex"),
  }
  const chooser = {
    valid: true,
    workspaceId: "ws-1",
    returnTo: "scan",
    github: {
      ...identity,
      purpose: "github-choose",
      providerUserId: 42,
      candidates: [
        { id: 777, login: "acme" },
        { id: 888, login: "other" },
      ],
    },
  }
  beforeEach(() => {
    vi.clearAllMocks()
    verifyInstallState.mockReturnValue(chooser)
    requirePermission.mockResolvedValue({ session: { userId: "user-1", sessionId: "session-1" } })
    exchangeInstallUserCode.mockResolvedValue("second-pass-token")
    getAppInstallations.mockResolvedValue([installation()])
    integrationUpsert.mockResolvedValue({ id: "int-1" })
    listInstallationRepos.mockResolvedValue([])
  })
  const select = (selectedId = 777) =>
    POST(
      new NextRequest("https://app.test/api/integrations/github/install", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "ws-1", chooserState: "chooser", selectedId }),
      })
    )
  it("begins another OAuth pass without binding or retaining the provider token", async () => {
    const response = await select()
    expect((await response.json()).data.installUrl).toContain("/login/oauth/authorize?")
    expect(exchangeInstallUserCode).not.toHaveBeenCalled()
    expect(integrationUpsert).not.toHaveBeenCalled()
  })
  it.each([999, -1])("rejects a selection outside signed candidates: %s", async (id) => {
    expect((await select(id)).status).toBe(400)
    expect(integrationUpsert).not.toHaveBeenCalled()
  })
  it("rejects selection after membership is revoked", async () => {
    requirePermission.mockRejectedValueOnce(new Error("FORBIDDEN"))
    expect((await select()).status).toBe(403)
  })
  it.each([
    [43, [{ id: 777, login: "acme" }], "identity_changed"],
    [42, [], "verification_required"],
  ])(
    "rejects changed provider identity or revoked admin authority",
    async (userId, installations, outcome) => {
      verifyInstallState.mockReturnValue({
        ...chooser,
        github: { ...identity, purpose: "github-selected", selectedId: 777, providerUserId: 42 },
      })
      getUserAdminInstallations.mockResolvedValue({ userId, installations })
      const response = await GET(callback("&code=second-code"))
      expect(response.headers.get("location")).toContain(`github=${outcome}`)
      expect(exchangeInstallUserCode).toHaveBeenCalledWith("second-code")
      expect(getUserAdminInstallations).toHaveBeenCalledWith("second-pass-token", 777)
      expect(integrationUpsert).not.toHaveBeenCalled()
    }
  )
  it("does not use a selected-ID context without a fresh code", async () => {
    verifyInstallState.mockReturnValue({
      ...chooser,
      github: { ...identity, purpose: "github-selected", selectedId: 777, providerUserId: 42 },
    })
    expect((await GET(callback())).headers.get("location")).toContain(
      "github=verification_required"
    )
    expect(integrationUpsert).not.toHaveBeenCalled()
  })
  it("sends a newly installed account with no OAuth code to a new proof step", async () => {
    verifyInstallState.mockReturnValue({
      ...chooser,
      github: { ...identity, purpose: "github-install" },
    })
    expect((await GET(callback())).headers.get("location")).toContain("/login/oauth/authorize?")
    expect(integrationUpsert).not.toHaveBeenCalled()
  })
})

it("round-trips real signed discovery, chooser and selected proof without persisting user tokens", async () => {
  vi.clearAllMocks()
  const actualState = await vi.importActual<typeof import("@/lib/github-install-state")>(
    "@/lib/github-install-state"
  )
  const stateModule = await import("@/lib/github-install-state")
  vi.mocked(stateModule.createInstallState).mockImplementation(actualState.createInstallState)
  verifyInstallState.mockImplementation(actualState.verifyInstallState)
  requirePermission.mockResolvedValue({ session: { userId: "user-1", sessionId: "session-1" } })
  getAppInstallations.mockResolvedValue([installation(), installation({ id: 888 })])
  integrationUpsert.mockResolvedValue({ id: "int-real-state" })
  listInstallationRepos.mockResolvedValue([])
  exchangeInstallUserCode
    .mockResolvedValueOnce("discarded-discovery-token")
    .mockResolvedValueOnce("fresh-selection-token")
  getUserAdminInstallations
    .mockResolvedValueOnce({
      userId: 42,
      installations: [
        { id: 777, login: "acme" },
        { id: 888, login: "other" },
      ],
    })
    .mockResolvedValueOnce({ userId: 42, installations: [{ id: 888, login: "other" }] })
  const initial = await POST(
    new NextRequest("https://app.test/api/integrations/github/install", {
      method: "POST",
      body: JSON.stringify({ workspaceId: "ws-1", returnTo: "scan" }),
    })
  )
  const initialUrl = new URL((await initial.json()).data.installUrl)
  expect(initialUrl.searchParams.get("redirect_uri")).toBe(
    "https://app.test/api/integrations/github/install"
  )
  const callbackUrl = new URL("https://app.test/api/integrations/github/install")
  callbackUrl.searchParams.set("state", initialUrl.searchParams.get("state")!)
  callbackUrl.searchParams.set("code", "discovery-code")
  const discovery = await GET(new NextRequest(callbackUrl))
  const chooserUrl = new URL(discovery.headers.get("location")!)
  expect(chooserUrl.pathname).toBe("/integrations/github/choose")
  const chooserState = chooserUrl.searchParams.get("state")!
  expect(actualState.verifyInstallState(chooserState)).toMatchObject({
    returnTo: "scan",
    github: { purpose: "github-choose", providerUserId: 42 },
  })
  expect(JSON.stringify(actualState.verifyInstallState(chooserState))).not.toContain(
    "discarded-discovery-token"
  )
  expect(integrationUpsert).not.toHaveBeenCalled()
  // Caller attempts to override destination: only the signed chooser's destination survives.
  const selection = await POST(
    new NextRequest("https://app.test/api/integrations/github/install", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: "ws-1",
        returnTo: "onboarding",
        chooserState,
        selectedId: 888,
      }),
    })
  )
  const selectedUrl = new URL((await selection.json()).data.installUrl)
  const selectedState = selectedUrl.searchParams.get("state")!
  expect(actualState.verifyInstallState(selectedState)).toMatchObject({
    returnTo: "scan",
    github: { purpose: "github-selected", providerUserId: 42, selectedId: 888 },
  })
  callbackUrl.searchParams.set("state", selectedState)
  callbackUrl.searchParams.set("code", "selection-code")
  const final = await GET(new NextRequest(callbackUrl))
  expect(final.headers.get("location")).toBe(
    "https://app.test/dashboard/scans?new=1&source=repo&connected=github"
  )
  expect(getUserAdminInstallations).toHaveBeenLastCalledWith("fresh-selection-token", 888)
  expect(integrationUpsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: expect.objectContaining({ workspaceId: "ws-1", externalId: "888" }),
    })
  )
  expect(JSON.stringify([integrationUpsert.mock.calls, auditLogCreate.mock.calls])).not.toContain(
    "-token"
  )
})

it("preserves a verified MCP onboarding return through fresh GitHub proof", async () => {
  const actualState = await vi.importActual<typeof import("@/lib/github-install-state")>(
    "@/lib/github-install-state"
  )
  const oauth = await import("@/lib/oauth-onboarding-return")
  vi.mocked(oauth.verifyOAuthOnboardingReturn).mockReturnValue({
    valid: true,
    userId: "user-1",
    oauthQuery: "client_id=fixture",
  })
  verifyInstallState.mockImplementation(actualState.verifyInstallState)
  requirePermission.mockResolvedValue({ session: { userId: "user-1", sessionId: "session-1" } })
  getAppInstallations.mockResolvedValue([installation()])
  exchangeInstallUserCode.mockResolvedValue("ephemeral")
  getUserAdminInstallations.mockResolvedValue({
    userId: 42,
    installations: [{ id: 777, login: "acme" }],
  })
  integrationUpsert.mockResolvedValue({ id: "integration-mcp" })
  listInstallationRepos.mockResolvedValue([])
  const state = actualState.createInstallState(
    "ws-1",
    "onboarding",
    Date.now(),
    "signed-mcp-return",
    {
      purpose: "github-discover",
      userId: "user-1",
      sessionHash: createHash("sha256").update("session-1").digest("hex"),
    }
  )
  const response = await GET(
    new NextRequest(
      `https://app.test/api/integrations/github/install?state=${encodeURIComponent(state)}&code=fresh-code`
    )
  )
  expect(response.headers.get("location")).toBe(
    "https://app.test/onboarding?oauth_return=signed-mcp-return&connected=github"
  )
})

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  integrationFindFirst: vi.fn(),
  listInstallationRepos: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { integration: { manage: "integration:manage" } },
}))
vi.mock("@lyrashield/db", () => ({
  prisma: { integration: { findFirst: mocks.integrationFindFirst } },
}))
vi.mock("@lyrashield/integrations", () => ({
  listInstallationRepos: mocks.listInstallationRepos,
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: mocks.loggerError } }))

import { GET } from "./route"

function request(workspaceId: string) {
  return new Request(
    `http://localhost/api/integrations/github/repos?workspaceId=${encodeURIComponent(workspaceId)}`
  )
}

describe("GET /api/integrations/github/repos", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.integrationFindFirst.mockResolvedValue({ externalId: "42" })
    mocks.listInstallationRepos.mockResolvedValue([
      {
        id: 7,
        full_name: "acme/private-app",
        name: "private-app",
        owner: { login: "acme" },
        default_branch: "main",
        private: true,
        html_url: "https://github.com/acme/private-app",
      },
    ])
  })

  it("lists only the authorized workspace installation's repository projection", async () => {
    const response = await GET(request("ws-1"))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      data: [
        {
          id: 7,
          fullName: "acme/private-app",
          name: "private-app",
          owner: "acme",
          defaultBranch: "main",
          private: true,
          htmlUrl: "https://github.com/acme/private-app",
          installationId: "42",
        },
      ],
    })
    expect(mocks.requirePermission).toHaveBeenCalledWith("ws-1", "integration:manage")
    expect(mocks.integrationFindFirst).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", type: "GITHUB", status: "active", deletedAt: null },
    })
    expect(mocks.listInstallationRepos).toHaveBeenCalledWith(42)
  })

  it.each([
    ["a viewer without integration management", "ws-1"],
    ["a member of a different workspace", "ws-other"],
  ])("does not list private repositories for %s", async (_caller, workspaceId) => {
    mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

    const response = await GET(request(workspaceId))

    expect(response.status).toBe(403)
    expect(mocks.requirePermission).toHaveBeenCalledWith(workspaceId, "integration:manage")
    expect(mocks.integrationFindFirst).not.toHaveBeenCalled()
    expect(mocks.listInstallationRepos).not.toHaveBeenCalled()
  })

  it("does not call GitHub when the authorized workspace has no active installation", async () => {
    mocks.integrationFindFirst.mockResolvedValueOnce(null)

    const response = await GET(request("ws-1"))

    expect(response.status).toBe(404)
    expect(mocks.listInstallationRepos).not.toHaveBeenCalled()
  })
})

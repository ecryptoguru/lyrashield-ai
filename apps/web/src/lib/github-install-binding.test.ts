import { beforeEach, expect, it, vi } from "vitest"
import { applyQueryGuards } from "../../../../packages/db/src/scoping"
const database = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  upsert: vi.fn(),
  audit: vi.fn(),
}))
vi.mock("@lyrashield/db", () => ({
  prisma: { integration: database, auditLog: { create: database.audit } },
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))
vi.mock("@lyrashield/integrations", () => ({
  connectorScopesForInstallationPermissions: () => [],
  listInstallationRepos: vi.fn(),
}))
import { bindGitHubInstallation } from "./github-install-binding"
const request = {
  installation: {
    id: 777,
    account: { id: 42, login: "owner", type: "User" },
    repository_selection: "all" as const,
  },
  workspaceId: "ws-1",
  userId: "user-1",
  setupAction: null,
  returnPath: "/onboarding",
  origin: new URL("https://app.test"),
}

beforeEach(() => vi.resetAllMocks())

it("revives a same-workspace soft-deleted row despite the actual read guard", async () => {
  const stored = {
    id: "integration-existing",
    workspaceId: "ws-1",
    externalId: "777",
    type: "GITHUB",
    deletedAt: new Date(),
    status: "disconnected",
  }
  database.findFirst.mockImplementation((args) => {
    const guarded = applyQueryGuards("Integration", "findFirst", args, "ws-1")
    return (guarded.where as { deletedAt?: unknown }).deletedAt === null ? null : stored
  })
  database.create.mockRejectedValue({ code: "P2002" })
  database.upsert.mockImplementation((args) => {
    const guarded = applyQueryGuards("Integration", "upsert", args, "ws-1")
    expect(guarded.where).toEqual({
      workspaceId_type_externalId: { workspaceId: "ws-1", type: "GITHUB", externalId: "777" },
    })
    Object.assign(stored, args.update)
    return stored
  })
  const response = await bindGitHubInstallation(request)
  expect(response.headers.get("location")).toBe("https://app.test/onboarding?connected=github")
  expect(stored).toMatchObject({
    id: "integration-existing",
    workspaceId: "ws-1",
    deletedAt: null,
    status: "active",
  })
  expect(database.audit).toHaveBeenCalledWith({
    data: {
      workspaceId: "ws-1",
      actorUserId: "user-1",
      action: "integration.github.connected",
      resourceType: "integration",
      resourceId: "integration-existing",
    },
  })
})

it.each([null, new Date("2026-01-01")])(
  "keeps a foreign installation with deletedAt=%s claimed by its original workspace",
  async (deletedAt) => {
    const foreign = { id: "foreign", workspaceId: "other-workspace", externalId: "777", deletedAt }
    database.upsert.mockImplementation((args) => {
      expect(args.where).toEqual({
        workspaceId_type_externalId: { workspaceId: "ws-1", type: "GITHUB", externalId: "777" },
      })
      // The workspace key does not match; the global key prevents a new row.
      if (args.where.workspaceId_type_externalId.workspaceId !== foreign.workspaceId)
        throw { code: "P2002" }
      Object.assign(foreign, args.update)
      return foreign
    })
    const response = await bindGitHubInstallation(request)
    expect(response.headers.get("location")).toBe(
      "https://app.test/onboarding?github=already_claimed"
    )
    expect(foreign).toEqual({
      id: "foreign",
      workspaceId: "other-workspace",
      externalId: "777",
      deletedAt,
    })
    expect(database.audit).not.toHaveBeenCalled()
    expect(database.update).not.toHaveBeenCalled()
  }
)
it("handles a global uniqueness race without reporting a successful connection", async () => {
  database.upsert.mockRejectedValue({ code: "P2002" })
  expect((await bindGitHubInstallation(request)).headers.get("location")).toBe(
    "https://app.test/onboarding?github=already_claimed"
  )
  expect(database.audit).not.toHaveBeenCalled()
  expect(database.update).not.toHaveBeenCalled()
})

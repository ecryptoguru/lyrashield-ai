import { randomInt, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma, withWorkspaceRLS } from "@lyrashield/db"

// Only the provider boundary is replaced. Binding, Prisma guards, database
// uniqueness and the extended-client audit chain all execute normally.
vi.mock("@lyrashield/integrations", () => ({
  connectorScopesForInstallationPermissions: () => ["repo:metadata"],
  listInstallationRepos: vi.fn(),
}))
import { bindGitHubInstallation } from "./github-install-binding"

const suffix = randomUUID().replace(/-/g, "")
const workspaces = [`github-reconnect-${suffix}`, `github-foreign-${suffix}`]
const installationId = randomInt(1_000_000_000, 2_000_000_000)
function bind(workspaceId: string, id = installationId) {
  return bindGitHubInstallation({
    installation: {
      id,
      account: { id: 42, login: "fixture-owner", type: "User" },
      repository_selection: "all",
    },
    workspaceId,
    userId: "fixture-user",
    setupAction: null,
    returnPath: "/onboarding",
    origin: new URL("https://app.test"),
  })
}

describe.skipIf(process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1")(
  "GitHub binding on disposable PostgreSQL with the real extended client",
  () => {
    beforeAll(async () => {
      for (const workspaceId of workspaces)
        await prisma.workspace.create({
          data: { id: workspaceId, name: "GitHub reconnect fixture", slug: workspaceId },
        })
    })
    afterAll(async () => {
      // Fixture cleanup only; production binding never uses raw/system reads.
      for (const workspaceId of workspaces) {
        await withWorkspaceRLS(workspaceId, async (tx) => {
          await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "workspaceId" = ${workspaceId}`
          await tx.$executeRaw`DELETE FROM "Integration" WHERE "workspaceId" = ${workspaceId}`
        })
        await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${workspaceId}`
      }
    })
    it("revives the original integration ID after the read guard hides its soft deletion", async () => {
      const workspaceId = workspaces[0]!
      expect((await bind(workspaceId)).headers.get("location")).toContain("connected=github")
      const row = await prisma.integration.findFirstOrThrow({
        where: { workspaceId, externalId: String(installationId) },
      })
      await prisma.integration.delete({ where: { id: row.id, workspaceId } })
      expect(
        await prisma.integration.findFirst({
          where: { workspaceId, externalId: String(installationId) },
        })
      ).toBeNull()
      expect((await bind(workspaceId)).headers.get("location")).toContain("connected=github")
      expect(
        await prisma.integration.findFirst({
          where: { workspaceId, externalId: String(installationId) },
        })
      ).toMatchObject({ id: row.id, deletedAt: null, status: "active" })
      expect(
        await prisma.auditLog.count({
          where: { workspaceId, action: "integration.github.connected" },
        })
      ).toBe(2)
    })
    it("rejects foreign active and soft-deleted rows without moving ownership", async () => {
      const [workspaceId, foreignWorkspaceId] = workspaces as [string, string]
      const row = await prisma.integration.findFirstOrThrow({
        where: { workspaceId, externalId: String(installationId) },
      })
      expect((await bind(foreignWorkspaceId)).headers.get("location")).toContain(
        "github=already_claimed"
      )
      await prisma.integration.delete({ where: { id: row.id, workspaceId } })
      expect((await bind(foreignWorkspaceId)).headers.get("location")).toContain(
        "github=already_claimed"
      )
      expect(
        await prisma.integration.count({
          where: { workspaceId: foreignWorkspaceId, externalId: String(installationId) },
        })
      ).toBe(0)
      expect((await bind(workspaceId)).headers.get("location")).toContain("connected=github")
      expect(
        await prisma.integration.findFirst({
          where: { workspaceId, externalId: String(installationId) },
        })
      ).toMatchObject({ id: row.id, workspaceId })
    })
    it("allows exactly one workspace to win a simultaneous first binding", async () => {
      const replies = await Promise.all(
        workspaces.map((workspaceId) => bind(workspaceId, installationId + 1))
      )
      const locations = replies.map((reply) => reply.headers.get("location")!)
      expect(locations.filter((location) => location.includes("connected=github"))).toHaveLength(1)
      expect(
        locations.filter((location) => location.includes("github=already_claimed"))
      ).toHaveLength(1)
    })
  }
)

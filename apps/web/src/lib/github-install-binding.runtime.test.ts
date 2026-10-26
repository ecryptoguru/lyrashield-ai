import { randomInt, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma, createBoundedPgAdapter } from "@lyrashield/db"
import { PrismaClient } from "../../../../packages/db/src/generated/prisma"

vi.mock("@lyrashield/config", async (original) => {
  const actual = await original<typeof import("@lyrashield/config")>()
  return {
    ...actual,
    env: {
      ...actual.env,
      DATABASE_URL: process.env.RLS_RUNTIME_DATABASE_URL ?? actual.env.DATABASE_URL,
    },
  }
})
const owner = new PrismaClient({ adapter: createBoundedPgAdapter(process.env.DATABASE_URL!) })

// Only the provider boundary is replaced. Binding, Prisma guards, database
// uniqueness and the extended-client audit chain all execute normally.
vi.mock("@lyrashield/integrations", () => ({
  connectorScopesForInstallationPermissions: () => ["repo:metadata"],
  listInstallationRepos: vi.fn(),
}))
import { bindGitHubInstallation } from "./github-install-binding"

const suffix = randomUUID().replace(/-/g, "")
const workspaces = Array.from({ length: 6 }, (_, i) => `github-binding-${i}-${suffix}`)
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
      if (process.env.RLS_RUNTIME_DATABASE_URL) {
        const [role] = await prisma.$queryRaw<
          Array<{ superuser: boolean; bypass: boolean }>
        >`SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
        expect(role).toEqual({ superuser: false, bypass: false })
      }
      for (const workspaceId of workspaces)
        await owner.workspace.create({
          data: { id: workspaceId, name: "GitHub reconnect fixture", slug: workspaceId },
        })
    })
    afterAll(async () => {
      // Fixture cleanup only; production binding never uses raw/system reads.
      for (const workspaceId of workspaces) {
        await owner.$executeRaw`DELETE FROM "AuditLog" WHERE "workspaceId" = ${workspaceId}`
        await owner.$executeRaw`DELETE FROM "Integration" WHERE "workspaceId" = ${workspaceId}`
        await owner.$executeRaw`DELETE FROM "Workspace" WHERE id = ${workspaceId}`
      }
      await owner.$disconnect()
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
        workspaces.slice(2, 4).map((workspaceId) => bind(workspaceId, installationId + 1))
      )
      const locations = replies.map((reply) => reply.headers.get("location")!)
      expect(locations.filter((location) => location.includes("connected=github"))).toHaveLength(1)
      expect(
        locations.filter((location) => location.includes("github=already_claimed"))
      ).toHaveLength(1)
    })
    it("preserves a workspace's active binding when another installation is selected", async () => {
      const workspaceId = workspaces[0]!
      expect((await bind(workspaceId, installationId + 2)).headers.get("location")).toContain(
        "github=workspace_already_connected"
      )
      const rows = await prisma.integration.findMany({
        where: { workspaceId, type: "GITHUB", status: "active" },
      })
      expect(rows.map((row) => row.externalId)).toEqual([String(installationId)])
    })
    it("serializes competing different installations within one workspace", async () => {
      const workspaceId = workspaces[4]!
      const replies = await Promise.all([
        bind(workspaceId, installationId + 3),
        bind(workspaceId, installationId + 4),
      ])
      const locations = replies.map((reply) => reply.headers.get("location")!)
      expect(locations.filter((location) => location.includes("connected=github"))).toHaveLength(1)
      expect(
        locations.filter((location) => location.includes("github=workspace_already_connected"))
      ).toHaveLength(1)
      expect(
        await prisma.integration.count({ where: { workspaceId, type: "GITHUB", status: "active" } })
      ).toBe(1)
      expect(
        await prisma.auditLog.count({
          where: { workspaceId, action: "integration.github.connected" },
        })
      ).toBe(1)
    })
    it("preserves and rejects an ambiguous legacy workspace with multiple active installations", async () => {
      const workspaceId = workspaces[5]!
      await owner.integration.createMany({
        data: [installationId + 10, installationId + 11].map((id) => ({
          workspaceId,
          type: "GITHUB",
          externalId: String(id),
          name: "legacy fixture",
          status: "active",
        })),
      })
      expect((await bind(workspaceId, installationId + 10)).headers.get("location")).toContain(
        "github=workspace_already_connected"
      )
      const rows = await prisma.integration.findMany({
        where: { workspaceId, type: "GITHUB", status: "active" },
        orderBy: { externalId: "asc" },
      })
      expect(rows.map((row) => row.externalId)).toEqual([
        String(installationId + 10),
        String(installationId + 11),
      ])
      expect(rows.every((row) => row.name === "legacy fixture")).toBe(true)
      expect(await prisma.auditLog.count({ where: { workspaceId } })).toBe(0)
    })
  }
)

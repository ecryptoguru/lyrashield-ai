import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "./generated/prisma"
import { resolveOAuthReadScope } from "../../auth/src/oauth-read-scope"

// Hoisting runs this guard before imports can construct the runtime client.
await vi.hoisted(async () => {
  if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE === "1" && process.env.RLS_RUNTIME_DATABASE_URL) {
    const { assertDisposableDatabasePair } =
      await import("../../../.github/scripts/vitest-database-env.mjs")
    assertDisposableDatabasePair(process.env)
  }
})

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

import { prisma } from "./client"
import { getFindingStats, listFindings } from "./finding-service"
import { listScans } from "./scan-service"
import { listReports } from "./report-list-service"
import { withWorkspaceRLS } from "./rls"

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})
const suffix = randomUUID()
const workspaceId = `oauth-read-${suffix}`
const foreignWorkspaceId = `oauth-foreign-${suffix}`
const allowedTargetId = `oauth-allowed-${suffix}`
const deniedTargetId = `oauth-denied-${suffix}`
const foreignTargetId = `oauth-foreign-target-${suffix}`
const rows = [
  { key: "allowed-1", workspaceId, targetId: allowedTargetId },
  { key: "denied", workspaceId, targetId: deniedTargetId },
  { key: "allowed-2", workspaceId, targetId: allowedTargetId },
  { key: "foreign", workspaceId: foreignWorkspaceId, targetId: foreignTargetId },
]
const id = (kind: string, key: string) => `oauth-${kind}-${key}-${suffix}`

describe.skipIf(!process.env.RLS_RUNTIME_DATABASE_URL)(
  "OAuth target read scopes against restricted PostgreSQL",
  () => {
    beforeAll(async () => {
      const [role] = await prisma.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
      `
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false })
      const protectedTables = await owner.$queryRaw<
        { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`
        SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname IN ('Scan', 'Finding', 'Report') ORDER BY relname
      `
      expect(protectedTables).toHaveLength(3)
      for (const table of protectedTables) {
        expect(table.relrowsecurity).toBe(true)
        expect(table.relforcerowsecurity).toBe(true)
      }
      await owner.workspace.createMany({
        data: [workspaceId, foreignWorkspaceId].map((workspace) => ({
          id: workspace,
          name: "OAuth read fixture",
          slug: workspace,
        })),
      })
      await owner.target.createMany({
        data: [
          { id: allowedTargetId, workspaceId },
          { id: deniedTargetId, workspaceId },
          { id: foreignTargetId, workspaceId: foreignWorkspaceId },
        ].map((target) => ({ ...target, name: "Read fixture", type: "REPO" as const })),
      })
      for (const [index, row] of rows.entries()) {
        const createdAt = new Date(1_790_000_000_000 + index * 1000)
        await owner.scan.create({
          data: {
            id: id("scan", row.key),
            workspaceId: row.workspaceId,
            targetId: row.targetId,
            goal: "TEST_APP",
            mode: "STANDARD",
            status: "COMPLETED",
            createdById: "synthetic-reader",
            createdAt,
          },
        })
        await owner.finding.create({
          data: {
            id: id("finding", row.key),
            workspaceId: row.workspaceId,
            targetId: row.targetId,
            scanId: id("scan", row.key),
            title: row.key,
            summary: "Synthetic read-scope fixture",
            dedupeKey: id("dedupe", row.key),
            severity: row.key === "denied" ? "CRITICAL" : "LOW",
            createdAt,
          },
        })
        await owner.report.create({
          data: {
            id: id("report", row.key),
            workspaceId: row.workspaceId,
            scanId: id("scan", row.key),
            title: row.key,
            createdById: "synthetic-reader",
            createdAt,
          },
        })
      }
    })

    afterAll(async () => {
      await owner.workspace.deleteMany({ where: { id: { in: [workspaceId, foreignWorkspaceId] } } })
      await owner.$disconnect()
      await prisma.$disconnect()
    })

    it("paginates the granted target and computes aggregates from the same rows", async () => {
      const scope = resolveOAuthReadScope({
        oauth: {
          userId: "synthetic-reader",
          workspaceId,
          scopes: ["lyrashield.read"],
          connectionId: "synthetic",
          allTargets: false,
          allowedTargetIds: [allowedTargetId],
        },
      })
      const first = await listFindings({ workspaceId, ...scope, limit: 1 })
      expect(first.items.map((finding) => finding.id)).toEqual([id("finding", "allowed-2")])
      expect(first.nextCursor).toBe(id("finding", "allowed-2"))
      const second = await listFindings({
        workspaceId,
        ...scope,
        limit: 1,
        cursor: first.nextCursor!,
      })
      expect(second.items.map((finding) => finding.id)).toEqual([id("finding", "allowed-1")])
      expect(second.nextCursor).toBeNull()
      expect(
        await getFindingStats(workspaceId, undefined, undefined, scope.targetIds)
      ).toMatchObject({
        total: 2,
        bySeverity: { LOW: 2 },
      })
      for (const kind of ["scan", "report"] as const) {
        const page =
          kind === "scan"
            ? await listScans({ workspaceId, ...scope, limit: 1 })
            : await listReports(workspaceId, undefined, 1, scope.targetIds)
        expect(page.items.map((item) => item.id)).toEqual([id(kind, "allowed-2")])
        const next =
          kind === "scan"
            ? await listScans({ workspaceId, ...scope, limit: 1, cursor: page.nextCursor! })
            : await listReports(workspaceId, page.nextCursor!, 1, scope.targetIds)
        expect(next.items.map((item) => item.id)).toEqual([id(kind, "allowed-1")])
        expect(next.nextCursor).toBeNull()
      }
    })

    it.each([{ targetIds: [] }, { targetIds: [foreignTargetId] }])(
      "keeps empty or foreign target grants empty: $targetIds",
      async ({ targetIds }) => {
        expect(await listFindings({ workspaceId, targetIds })).toEqual({
          items: [],
          nextCursor: null,
        })
        expect(await listScans({ workspaceId, targetIds })).toEqual({ items: [], nextCursor: null })
        expect(await listReports(workspaceId, undefined, 50, targetIds)).toEqual({
          items: [],
          nextCursor: null,
        })
        expect(await getFindingStats(workspaceId, undefined, undefined, targetIds)).toMatchObject({
          total: 0,
          bySeverity: {},
        })
      }
    )

    it("preserves all-target reads within the workspace and blocks unbound RLS queries", async () => {
      expect((await listFindings({ workspaceId })).items).toHaveLength(3)
      expect((await listScans({ workspaceId })).items).toHaveLength(3)
      expect((await listReports(workspaceId)).items).toHaveLength(3)
      expect((await getFindingStats(workspaceId)).total).toBe(3)
      expect(await prisma.$queryRaw`SELECT id FROM "Finding"`).toEqual([])
      const foreign = await withWorkspaceRLS(workspaceId, (tx) =>
        tx.finding.findMany({ where: { workspaceId: foreignWorkspaceId } })
      )
      expect(foreign).toEqual([])
    })
  }
)

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "./client"
import { withWorkspaceRLS, withoutWorkspaceRLS } from "./rls"

/**
 * Proves workspace isolation is enforced by Postgres, not merely declared.
 *
 * The existing suite proves two things by inspection: that WORKSPACE_SCOPED_MODELS matches
 * the RLS-protected table set exactly, and that the extension injects a workspace filter.
 * Neither executes a query against a real database, so neither would catch a policy that
 * was dropped, mis-scoped, or silently reverted to allow-all — the failure mode that
 * returns another tenant's rows instead of raising an error.
 *
 * These assertions close that loop. They need the Postgres service, so like
 * soft-delete.test.ts they run in CI rather than in a bare sandbox.
 */
const suffix = `${Date.now()}`
const workspaceId = `rls-fc-owner-${suffix}`
const otherWorkspaceId = `rls-fc-other-${suffix}`
let targetId = ""

describe("strict workspace RLS fails closed", () => {
  beforeAll(async () => {
    await prisma.workspace.create({
      data: { id: workspaceId, name: "RLS fail-closed owner", slug: workspaceId },
    })
    await prisma.workspace.create({
      data: { id: otherWorkspaceId, name: "RLS fail-closed other", slug: otherWorkspaceId },
    })
    const target = await prisma.target.create({
      data: {
        workspaceId,
        type: "REPO",
        name: "RLS fail-closed target",
        repoFullName: `rls-fail-closed-${suffix}`,
      },
    })
    targetId = target.id
  })

  afterAll(async () => {
    if (targetId) {
      await withWorkspaceRLS(
        workspaceId,
        (tx) => tx.$executeRaw`DELETE FROM "Target" WHERE id = ${targetId}`
      )
    }
    await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id IN (${workspaceId}, ${otherWorkspaceId})`
    await prisma.$disconnect()
  })

  async function rawTargetCount(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
  ): Promise<number> {
    // Raw SQL deliberately bypasses the Prisma extension's workspace filter, so what is
    // being measured here is the database policy on its own.
    const rows = await tx.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*)::bigint AS count FROM "Target" WHERE id = ${targetId}`
    return Number(rows[0]?.count ?? 0)
  }

  it("returns the row to its owning workspace", async () => {
    const count = await withWorkspaceRLS(workspaceId, rawTargetCount)
    expect(count).toBe(1)
  })

  it("returns nothing when the workspace context is absent", async () => {
    // The dangerous regression is this returning 1: a query path that forgot the wrapper
    // would then read across every tenant instead of failing.
    const count = await withoutWorkspaceRLS(rawTargetCount)
    expect(count).toBe(0)
  })

  it("returns nothing to a different workspace", async () => {
    const count = await withWorkspaceRLS(otherWorkspaceId, rawTargetCount)
    expect(count).toBe(0)
  })

  it("hides the row from an unscoped aggregate over the whole table", async () => {
    const total = await withoutWorkspaceRLS(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT count(*)::bigint AS count FROM "Target"`
      return Number(rows[0]?.count ?? 0)
    })
    expect(total).toBe(0)
  })

  it("refuses to write into a workspace other than the active one", async () => {
    await expect(
      withWorkspaceRLS(
        otherWorkspaceId,
        (tx) => tx.$executeRaw`UPDATE "Target" SET name = 'hijacked' WHERE id = ${targetId}`
      )
    ).resolves.toBe(0)

    const name = await withWorkspaceRLS(workspaceId, async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ name: string }>
      >`SELECT name FROM "Target" WHERE id = ${targetId}`
      return rows[0]?.name
    })
    expect(name).toBe("RLS fail-closed target")
  })
})

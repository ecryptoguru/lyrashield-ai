import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "./client"
import { isDatabaseRLSContextBound, runWithWorkspaceContext } from "./scoping"
import { withWorkspaceRLS } from "./rls"

const suffix = `${Date.now()}`
const workspaceId = `soft-delete-workspace-${suffix}`
let targetId = ""

describe("Prisma extension soft delete", () => {
  beforeAll(async () => {
    await prisma.workspace.create({
      data: { id: workspaceId, name: "Soft delete", slug: workspaceId },
    })
    const target = await prisma.target.create({
      data: {
        workspaceId,
        type: "REPO",
        name: "Soft-delete target",
        repoFullName: `soft-delete-${suffix}`,
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
    await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${workspaceId}`
    await prisma.$disconnect()
  })

  it("maps delete to update and retains the row with deletedAt", async () => {
    expect(isDatabaseRLSContextBound()).toBe(false)
    const transactionVisible = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.target.findFirst({ where: { id: targetId } })
    )
    expect(transactionVisible?.id).toBe(targetId)
    expect(isDatabaseRLSContextBound()).toBe(false)

    const beforeDelete = await runWithWorkspaceContext(workspaceId, () =>
      prisma.target.findFirst({ where: { id: targetId } })
    )
    expect(beforeDelete?.id).toBe(targetId)

    await runWithWorkspaceContext(workspaceId, () =>
      prisma.target.delete({ where: { id: targetId } })
    )

    expect(await prisma.target.findFirst({ where: { id: targetId, workspaceId } })).toBeNull()
    const rows = await withWorkspaceRLS(
      workspaceId,
      (tx) =>
        tx.$queryRaw<Array<{ deletedAt: Date | null }>>`
        SELECT "deletedAt" FROM "Target" WHERE id = ${targetId}`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.deletedAt).toBeInstanceOf(Date)
  })
})

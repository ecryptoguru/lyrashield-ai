import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "./client"
import { verifyAuditChain } from "./audit-hash"

const workspaceId = `audit-concurrency-${Date.now()}`

describe("audit hash chain concurrency", () => {
  beforeAll(async () => {
    await prisma.workspace.create({
      data: { id: workspaceId, name: "Audit concurrency", slug: workspaceId },
    })
  })

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "workspaceId" = ${workspaceId}`
    await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${workspaceId}`
    await prisma.$disconnect()
  })

  it("keeps concurrent writes in one linear chain", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        prisma.auditLog.create({
          data: {
            workspaceId,
            action: `concurrent.${i}`,
            resourceType: "test",
          },
        })
      )
    )

    const entries = await prisma.auditLog.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
    expect(entries).toHaveLength(8)
    expect(verifyAuditChain(entries)).toBe(true)
  })
})

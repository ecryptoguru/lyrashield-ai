import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "./client"
import { verifyAuditChain } from "./audit-hash"

const suffix = `${Date.now()}`
const userId = `delete-user-${suffix}`
const otherUserId = `keep-user-${suffix}`
const workspaceId = `delete-workspace-${suffix}`

describe("account deletion", () => {
  it("exports the privacy lifecycle service", async () => {
    const exports = (await import("./index")) as Record<string, unknown>
    expect(exports.deleteUserAccount).toBeTypeOf("function")
  })

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: userId, name: "Delete", email: `${userId}@example.com` },
        { id: otherUserId, name: "Keep", email: `${otherUserId}@example.com` },
      ],
    })
    await prisma.workspace.create({
      data: { id: workspaceId, name: "Deletion", slug: workspaceId },
    })
    await prisma.workspaceMember.create({
      data: { workspaceId, userId, role: "OWNER", status: "active" },
    })
  })

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "workspaceId" = ${workspaceId}`
    await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${workspaceId}`
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } })
    await prisma.$disconnect()
  })

  it("blocks sole owners, then anonymizes attribution without breaking the audit chain", async () => {
    const { AccountDeletionBlockedError, deleteUserAccount } = await import("./account-deletion")
    await expect(deleteUserAccount(userId)).rejects.toBeInstanceOf(AccountDeletionBlockedError)

    await prisma.workspaceMember.create({
      data: { workspaceId, userId: otherUserId, role: "OWNER", status: "active" },
    })
    await prisma.project.create({
      data: { workspaceId, name: "Owned project", ownerUserId: userId },
    })
    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: userId,
        action: "privacy.test",
        resourceType: "user",
      },
    })

    await deleteUserAccount(userId)

    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull()
    expect(await prisma.workspaceMember.count({ where: { userId } })).toBe(0)
    expect(await prisma.project.findFirst({ where: { workspaceId } })).toMatchObject({
      ownerUserId: null,
    })
    const entries = await prisma.auditLog.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
    expect(entries.some((entry) => entry.action === "account.deleted")).toBe(true)
    expect(verifyAuditChain(entries)).toBe(true)
  })
})

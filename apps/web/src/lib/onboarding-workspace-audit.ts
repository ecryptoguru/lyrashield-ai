import { prisma, withWorkspaceRLS } from "@lyrashield/db"

/** Deliver the creation audit without nesting the audit chain transaction. */
export async function deliverOnboardingWorkspaceAudit(userId: string, workspaceId: string) {
  const data = {
    id: workspaceId,
    workspaceId,
    actorUserId: userId,
    action: "workspace.created",
    resourceType: "workspace",
    resourceId: workspaceId,
  }

  for (let attempt = 0; ; attempt++) {
    try {
      await prisma.auditLog.create({ data })
      break
    } catch (error) {
      // The audit transaction may have committed even if its response was lost.
      const recorded = await withWorkspaceRLS(workspaceId, (tx) =>
        tx.auditLog.findFirst({
          where: { id: workspaceId, workspaceId },
          select: {
            id: true,
            workspaceId: true,
            actorUserId: true,
            action: true,
            resourceType: true,
            resourceId: true,
          },
        })
      )
      if (recorded) {
        if (Object.entries(data).some(([key, value]) => Reflect.get(recorded, key) !== value)) {
          throw new Error("Onboarding workspace audit identity differs")
        }
        break
      }
      if (attempt >= 1) throw error
    }
  }

  // Preserve the optimistic onboarding timestamp and never clear a later marker.
  await prisma.$executeRaw`
    UPDATE "onboarding_states" SET "pendingWorkspaceCreatedAuditId" = NULL
    WHERE "userId" = ${userId} AND "pendingWorkspaceCreatedAuditId" = ${workspaceId}
  `
}

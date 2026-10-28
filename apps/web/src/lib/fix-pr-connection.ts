import { withWorkspaceRLS } from "@lyrashield/db"

/** A stored proposal does not retain authority after its connection is disabled. */
export async function hasActiveFixPrConnection(
  workspaceId: string,
  installationId: number
): Promise<boolean> {
  return withWorkspaceRLS(workspaceId, async (tx) =>
    Boolean(
      await tx.integration.findFirst({
        where: {
          workspaceId,
          type: "GITHUB",
          externalId: String(installationId),
          status: "active",
          deletedAt: null,
        },
        select: { id: true },
      })
    )
  )
}

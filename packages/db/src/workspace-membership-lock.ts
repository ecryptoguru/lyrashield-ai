import type { Prisma } from "./generated/prisma"

/** Serialize ownership changes without blocking unrelated workspace foreign-key inserts. */
export async function lockWorkspaceMembership(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  workspaceId: string
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR NO KEY UPDATE`
}

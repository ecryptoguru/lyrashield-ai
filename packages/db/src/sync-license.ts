import { getSystemPrisma } from "./system-client"

/**
 * Narrow privileged adapter for sync license lookup.
 *
 * Cross-workspace read is required because a direct-purchase license starts
 * with workspaceId=NULL (NOBYPASSRLS would hide it from the request's
 * workspace-scoped client). This adapter is the ONLY sync code-path that may
 * use the system client, and it returns the minimal projection needed to
 * authorize the workspace-bound sync operation.
 *
 * All writes remain bound to the authenticated workspace via withWorkspaceRLS.
 */
export async function findLicenseForSyncByKeyHash(keyHash: string) {
  const systemPrisma = getSystemPrisma()
  return systemPrisma.licenseKey.findUnique({
    where: { keyHash },
    select: {
      id: true,
      licenseId: true,
      license: {
        select: {
          id: true,
          workspaceId: true,
          sku: true,
          revoked: true,
        },
      },
    },
  })
}

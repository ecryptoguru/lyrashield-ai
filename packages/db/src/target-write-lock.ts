import { lockWorkspaceScanAdmission } from "./scan-slot"
import type { ScopedTransaction } from "./rls"

/**
 * Serialize a delegated derived write with target deletion using the same
 * workspace -> target advisory-lock order as scan creation and deletion.
 * The row is re-read after both locks, so a deletion committed while waiting
 * cannot authorize a later report/share/proposal mutation.
 */
export async function lockActiveTargetForDerivedWrite(
  tx: ScopedTransaction,
  workspaceId: string,
  targetId: string
): Promise<boolean> {
  await lockWorkspaceScanAdmission(tx, workspaceId)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${targetId}))`
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM "Target"
    WHERE id = ${targetId}
      AND "workspaceId" = ${workspaceId}
      AND "deletedAt" IS NULL
    FOR SHARE
    LIMIT 1
  `
  return rows.length === 1
}

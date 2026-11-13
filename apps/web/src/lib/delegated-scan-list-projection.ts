import { getDelegatedScanAccessBatch, type ScopedTransaction } from "@lyrashield/db"
import type { AuthSession, WorkspaceContext } from "@lyrashield/auth/server"
import { serializeScanListItem } from "../app/api/scans/scan-list-response"
import { delegatedReadPrincipal } from "./delegated-target-read-scope"

type ScanListItem = Parameters<typeof serializeScanListItem>[0]
type SerializedScanListItem = ReturnType<typeof serializeScanListItem>

/** Preserve the selected post-deletion disclosure contract in delegated lists. */
export async function projectDelegatedScanList(
  session: AuthSession,
  workspace: WorkspaceContext,
  items: ScanListItem[],
  client?: ScopedTransaction
): Promise<SerializedScanListItem[]> {
  if (items.length === 0) return []
  const principal = delegatedReadPrincipal(session, workspace)
  if (!principal) throw new Error("FORBIDDEN")
  const accessRows = await getDelegatedScanAccessBatch(
    {
      ...principal,
      scanIds: items.map((item) => item.id),
    },
    client
  )
  const accessBySource = new Map(accessRows.map((access) => [access.sourceId, access]))
  return items.flatMap((item) => {
    const access = accessBySource.get(item.id)
    if (!access) return []
    if (!access.statusOnly) return [serializeScanListItem(item)]
    return [
      {
        ...(access.scanId ? { id: access.scanId } : {}),
        status: access.status,
      },
    ] as SerializedScanListItem[]
  })
}

import { listEvidenceFindings } from "@lyrashield/db"
import { EvidenceListClient } from "./evidence-list-client"

export async function EvidenceList({
  workspaceId,
  targetId,
  observedInScanId,
}: {
  workspaceId: string
  targetId?: string
  observedInScanId?: string
}) {
  const { items, nextCursor } = await listEvidenceFindings({
    workspaceId,
    ...(targetId ? { targetId } : {}),
    ...(observedInScanId ? { observedInScanId } : {}),
    limit: 25,
  })

  return (
    <EvidenceListClient
      workspaceId={workspaceId}
      {...(targetId ? { targetId } : {})}
      {...(observedInScanId ? { observedInScanId } : {})}
      initialData={items.map((finding) => ({
        ...finding,
        evidence: finding.evidence.map((evidence) => ({
          ...evidence,
          createdAt: evidence.createdAt.toISOString(),
        })),
      }))}
      initialNextCursor={nextCursor}
    />
  )
}

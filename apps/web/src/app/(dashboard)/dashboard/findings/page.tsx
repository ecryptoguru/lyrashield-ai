import { getCachedSession, getCachedWorkspaceId, getCachedFindings } from "@/lib/cache"
import { FindingsClient, type FindingListItem } from "./findings-client"

export default async function FindingsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) return null

  const findings = await getCachedFindings(workspaceId)

  const initialData: FindingListItem[] = findings.map((f) => ({
    id: f.id,
    title: f.title,
    summary: f.summary,
    severity: f.severity as FindingListItem["severity"],
    status: f.status,
    verified: f.verified,
    verificationStatus: f.verificationStatus,
    verificationMethod: f.verificationMethod,
    verificationReason: f.verificationReason,
    confidence: f.confidence,
    cwe: f.cwe,
    cvssScore: f.cvssScore,
    target: f.target,
    _count: f._count,
    firstSeenAt: f.firstSeenAt.toISOString(),
    lastSeenAt: f.lastSeenAt.toISOString(),
  }))

  return <FindingsClient workspaceId={workspaceId} initialData={initialData} />
}

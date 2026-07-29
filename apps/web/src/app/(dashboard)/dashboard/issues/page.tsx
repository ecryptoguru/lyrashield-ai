import { getCachedSession, getCachedWorkspaceId, getCachedFindings } from "@/lib/cache"
import { prisma } from "@lyrashield/db"
import { ShieldAlert } from "lucide-react"
import { FindingsClient, type FindingListItem } from "../findings/findings-client"
import { NoWorkspaceState } from "@/components/no-workspace-state"

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<{ finding?: string }>
}) {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Issues</h1>
        <NoWorkspaceState
          icon={ShieldAlert}
          description="Create a workspace during onboarding to view issues."
        />
      </div>
    )
  }

  const { finding: requestedFindingId } = await searchParams
  const [{ items: findings, nextCursor }, requestedFinding] = await Promise.all([
    getCachedFindings(workspaceId),
    requestedFindingId
      ? prisma.finding.findFirst({
          where: { id: requestedFindingId, workspaceId, deletedAt: null },
          include: {
            target: { select: { id: true, name: true, type: true } },
            _count: {
              select: {
                evidence: { where: { redactionStatus: { not: "deleted" } } },
                fixProposals: { where: { deletedAt: null } },
              },
            },
          },
        })
      : Promise.resolve(null),
  ])
  const visibleFindings =
    requestedFinding && !findings.some((finding) => finding.id === requestedFindingId)
      ? [requestedFinding, ...findings]
      : findings

  const initialData: FindingListItem[] = visibleFindings.map((f) => ({
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

  return (
    <FindingsClient
      workspaceId={workspaceId}
      initialData={initialData}
      initialNextCursor={nextCursor}
      initialSelectedFindingId={requestedFindingId}
    />
  )
}

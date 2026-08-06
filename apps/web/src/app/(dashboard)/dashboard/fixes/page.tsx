import { prisma } from "@lyrashield/db"
import { redirect } from "next/navigation"
import { Wrench } from "lucide-react"
import { FixesClient } from "./fixes-client"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"

export default async function FixesPage() {
  const session = await getCachedSession()
  if (!session) redirect("/sign-in")

  const workspaceId = await getCachedWorkspaceId(session.userId)

  if (!workspaceId) {
    return (
      <div>
        <PageHeader
          title="Proposed fixes"
          description="Review proposed fixes and track pull requests for your issues."
        />
        <NoWorkspaceState
          icon={Wrench}
          description="Create a workspace first to manage fix proposals."
        />
      </div>
    )
  }

  const limit = 20
  const proposals = await prisma.fixProposal.findMany({
    where: {
      deletedAt: null,
      finding: { workspaceId, deletedAt: null },
    },
    include: {
      finding: {
        select: {
          id: true,
          title: true,
          severity: true,
          status: true,
          cwe: true,
          target: { select: { id: true, name: true, repoFullName: true } },
        },
      },
      pullRequests: true,
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
  })

  const hasMore = proposals.length > limit
  const items = hasMore ? proposals.slice(0, limit) : proposals
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null

  const initialData = items.map((p) => ({
    id: p.id,
    kind: p.kind,
    summary: p.summary,
    status: p.status,
    safetyScore: p.safetyScore,
    generatedByModel: p.generatedByModel,
    createdAt: p.createdAt.toISOString(),
    finding: {
      id: p.finding.id,
      title: p.finding.title,
      severity: p.finding.severity,
      status: p.finding.status,
      cwe: p.finding.cwe,
      target: p.finding.target,
    },
    pullRequests: p.pullRequests.map((pr) => ({
      id: pr.id,
      provider: pr.provider,
      repoOwner: pr.repoOwner,
      repoName: pr.repoName,
      branchName: pr.branchName,
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      status: pr.status,
    })),
  }))

  return (
    <FixesClient
      workspaceId={workspaceId}
      initialData={initialData}
      initialNextCursor={nextCursor}
    />
  )
}

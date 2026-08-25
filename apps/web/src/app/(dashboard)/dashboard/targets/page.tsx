import type { Metadata } from "next"
import { prisma } from "@lyrashield/db"
import { redirect } from "next/navigation"
import { Crosshair } from "lucide-react"
import { TargetsClient } from "./targets-client"
import { TARGET_PLURAL } from "@/lib/terminology"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"

export const metadata: Metadata = {
  title: "Targets",
}

export default async function TargetsPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string }>
}) {
  const session = await getCachedSession()
  if (!session) redirect("/sign-in")

  const params = await searchParams

  const workspaceId = await getCachedWorkspaceId(session.userId)

  if (!workspaceId) {
    return (
      <div>
        <PageHeader
          title={TARGET_PLURAL}
          description="Manage the apps, APIs, repositories, and infrastructure to scan."
        />
        <NoWorkspaceState
          icon={Crosshair}
          description={`Create a workspace first to start managing ${TARGET_PLURAL.toLowerCase()}.`}
        />
      </div>
    )
  }

  const limit = 50
  const initialTargets = await prisma.target.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      ...(params.projectId ? { projectId: params.projectId } : {}),
    },
    include: {
      project: { select: { id: true, name: true } },
      _count: { select: { scans: true, findings: true } },
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
  })

  const hasMore = initialTargets.length > limit
  const items = hasMore ? initialTargets.slice(0, limit) : initialTargets
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null

  const githubIntegration = await prisma.integration.findFirst({
    where: { workspaceId, type: "GITHUB", status: "active", deletedAt: null },
  })
  const githubConnected = !!githubIntegration
  const githubAccountLogin =
    (githubIntegration?.metadata as { accountLogin?: string } | null)?.accountLogin ?? null

  const initialData = items.map((t) => ({
    id: t.id,
    name: t.name,
    type: t.type,
    url: t.url,
    apiSpecUrl: t.apiSpecUrl,
    repoFullName: t.repoFullName,
    branch: t.branch,
    environment: t.environment,
    status: t.status,
    lastScanAt: t.lastScanAt ? t.lastScanAt.toISOString() : null,
    project: t.project,
    scanCount: t._count.scans,
    findingCount: t._count.findings,
    createdAt: t.createdAt.toISOString(),
  }))

  return (
    <TargetsClient
      workspaceId={workspaceId}
      initialProjectId={params.projectId}
      initialData={initialData}
      initialNextCursor={nextCursor}
      githubConnected={githubConnected}
      githubAccountLogin={githubAccountLogin}
    />
  )
}

import Link from "next/link"
import { Play, ShieldCheck } from "lucide-react"
import { prisma } from "@lyrashield/db"
import { redirect } from "next/navigation"
import { TargetsClient } from "../targets/targets-client"
import { EmptyState, buttonVariants } from "@lyrashield/ui"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"

export default async function ProductsPage({
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
      <EmptyState
        icon={ShieldCheck}
        title="No workspace yet"
        description="Create a workspace first to start managing products."
        action={
          <Link href="/onboarding" className={buttonVariants()}>
            <Play className="size-4" aria-hidden="true" />
            Create workspace
          </Link>
        }
      />
    )
  }

  const limit = 50
  const [initialTargets, githubIntegration] = await Promise.all([
    prisma.target.findMany({
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
    }),
    prisma.integration.findFirst({
      where: { workspaceId, type: "GITHUB", status: "active", deletedAt: null },
    }),
  ])

  const hasMore = initialTargets.length > limit
  const items = hasMore ? initialTargets.slice(0, limit) : initialTargets
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null

  const githubConnected = !!githubIntegration
  const githubAccountLogin =
    (githubIntegration?.metadata as { accountLogin?: string } | null)?.accountLogin ?? null

  const initialData = items.map((t) => ({
    id: t.id,
    name: t.name,
    type: t.type,
    url: t.url,
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

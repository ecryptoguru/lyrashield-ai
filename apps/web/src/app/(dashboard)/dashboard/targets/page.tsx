import { getSession } from "@lyrashield/auth/server"
import { prisma } from "@lyrashield/db"
import { redirect } from "next/navigation"
import { TargetsClient } from "./targets-client"
import { getCachedWorkspaceId, getCachedProjects } from "@/lib/cache"

export default async function TargetsPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string }>
}) {
  const session = await getSession()
  if (!session) redirect("/sign-in")

  const params = await searchParams

  const workspaceId = await getCachedWorkspaceId(session.userId)

  if (!workspaceId) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <h2 className="mb-2 text-lg font-semibold">No workspace yet</h2>
        <p className="text-sm text-muted-foreground">
          Create a workspace first to start managing targets.
        </p>
      </div>
    )
  }

  const [projects, initialTargets] = await Promise.all([
    getCachedProjects(workspaceId),
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
      take: 50,
    }),
  ])

  const initialData = initialTargets.map((t) => ({
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
      projects={projects}
      initialProjectId={params.projectId}
      initialData={initialData}
    />
  )
}

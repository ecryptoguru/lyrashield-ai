import { prisma } from "@lyrashield/db"
import { redirect } from "next/navigation"
import { ProjectsClient } from "./projects-client"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"

export default async function ProjectsPage() {
  const session = await getCachedSession()
  if (!session) redirect("/sign-in")

  const workspaceId = await getCachedWorkspaceId(session.userId)

  if (!workspaceId) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <h2 className="mb-2 text-lg font-semibold">No workspace yet</h2>
        <p className="text-sm text-muted-foreground">
          Create a workspace first to start managing projects.
        </p>
      </div>
    )
  }

  const limit = 50
  const projects = await prisma.project.findMany({
    where: { workspaceId },
    include: {
      _count: { select: { targets: true, scans: true, findings: true } },
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
  })

  const hasMore = projects.length > limit
  const items = hasMore ? projects.slice(0, limit) : projects
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null

  const initialData = items.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    riskScore: p.riskScore,
    createdAt: p.createdAt.toISOString(),
    targetCount: p._count.targets,
    scanCount: p._count.scans,
    findingCount: p._count.findings,
  }))

  return <ProjectsClient workspaceId={workspaceId} initialData={initialData} initialNextCursor={nextCursor} />
}

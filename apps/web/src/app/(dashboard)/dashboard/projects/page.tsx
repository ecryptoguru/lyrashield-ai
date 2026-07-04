import { getSession } from "@lyrashield/auth/server"
import { prisma } from "@lyrashield/db"
import { redirect } from "next/navigation"
import { ProjectsClient } from "./projects-client"
import { getCachedWorkspaceId } from "@/lib/cache"

export default async function ProjectsPage() {
  const session = await getSession()
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

  const projects = await prisma.project.findMany({
    where: { workspaceId },
    include: {
      _count: { select: { targets: true, scans: true, findings: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  })

  const initialData = projects.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    riskScore: p.riskScore,
    createdAt: p.createdAt.toISOString(),
    targetCount: p._count.targets,
    scanCount: p._count.scans,
    findingCount: p._count.findings,
  }))

  return <ProjectsClient workspaceId={workspaceId} initialData={initialData} />
}

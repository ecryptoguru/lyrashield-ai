import { prisma } from "@lyrashield/db"
import { redirect } from "next/navigation"
import { ScansClient } from "./scans-client"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"

export default async function ScansPage() {
  const session = await getCachedSession()
  if (!session) redirect("/sign-in")

  const workspaceId = await getCachedWorkspaceId(session.userId)

  if (!workspaceId) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <h2 className="mb-2 text-lg font-semibold">No workspace yet</h2>
        <p className="text-muted-foreground text-sm">
          Create a workspace first to start running scans.
        </p>
      </div>
    )
  }

  const limit = 50
  const [targets, initialScans] = await Promise.all([
    prisma.target.findMany({
      where: { workspaceId, deletedAt: null },
      select: { id: true, name: true, type: true, url: true, repoFullName: true },
      orderBy: { name: "asc" },
    }),
    prisma.scan.findMany({
      where: { workspaceId, deletedAt: null },
      include: {
        target: { select: { id: true, name: true, type: true, url: true, repoFullName: true } },
        _count: { select: { findings: { where: { deletedAt: null } } } },
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
    }),
  ])

  const hasMore = initialScans.length > limit
  const items = hasMore ? initialScans.slice(0, limit) : initialScans
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null

  const initialData = items.map((s) => ({
    id: s.id,
    status: s.status,
    goal: s.goal,
    mode: s.mode,
    triggerType: s.triggerType,
    startedAt: s.startedAt ? s.startedAt.toISOString() : null,
    endedAt: s.endedAt ? s.endedAt.toISOString() : null,
    summary: s.summary,
    errorCategory: s.errorCategory,
    errorMessage: s.errorMessage,
    findingCount: s._count?.findings ?? 0,
    target: s.target,
    createdAt: s.createdAt.toISOString(),
  }))

  return (
    <ScansClient
      workspaceId={workspaceId}
      targets={targets.map((t) => ({
        id: t.id,
        name: t.name,
        type: t.type,
        url: t.url,
        repoFullName: t.repoFullName,
      }))}
      initialData={initialData}
      initialNextCursor={nextCursor}
    />
  )
}

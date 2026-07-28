import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { prisma } from "@lyrashield/db"
import { EmptyState } from "@lyrashield/ui"
import { ClipboardCheck, ClipboardList } from "lucide-react"
import Link from "next/link"

export default async function ApprovalsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Approval Centre</h1>
        <EmptyState
          icon={ClipboardCheck}
          title="No workspace yet"
          description="Create a workspace during onboarding to view approvals."
        />
      </div>
    )
  }

  const proposals = await prisma.fixProposal.findMany({
    where: {
      finding: { workspaceId, deletedAt: null },
      status: { in: ["draft", "pending"] },
      deletedAt: null,
    },
    include: {
      finding: {
        select: { id: true, title: true, severity: true, status: true },
      },
      pullRequests: { select: { id: true, status: true, provider: true }, where: { deletedAt: null } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  })

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Approval Centre</h1>
        <p className="text-muted-foreground text-sm">
          Review and approve remediation actions before they are applied.
        </p>
      </div>

      {proposals.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No pending approvals"
          description="Fix proposals will appear here once the engine generates them and they await approval."
        />
      ) : (
        <div className="grid gap-3">
          {proposals.map((p) => (
            <Link
              key={p.id}
              href={`/dashboard/findings/${p.findingId}`}
              className="group block rounded-xl border bg-card p-4 transition-colors hover:border-primary/50 hover:shadow-card-hover"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-semibold tracking-tight group-hover:text-primary">{p.summary}</h3>
                  <p className="text-muted-foreground text-sm">{p.finding.title}</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {p.kind} · {p.pullRequests.length} PR{p.pullRequests.length === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <span className="inline-flex items-center rounded-full bg-warning/10 px-2.5 py-0.5 text-xs font-medium text-warning">
                    {p.status}
                  </span>
                  <p className="text-muted-foreground mt-1 text-xs uppercase">{p.finding.severity}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

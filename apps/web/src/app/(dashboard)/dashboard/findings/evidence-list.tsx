import Link from "next/link"
import { prisma } from "@lyrashield/db"
import { EmptyState, buttonVariants } from "@lyrashield/ui"
import { ShieldAlert } from "lucide-react"
import { evidenceTypeLabel } from "@/lib/labels"

/**
 * Reusable verified-evidence view. Renders the list of findings that carry
 * independently verified evidence records. Used by the Issues → Evidence tab
 * and the legacy /dashboard/evidence compatibility route.
 *
 * The query is workspace-scoped and RLS-safe: the caller is responsible for
 * resolving the active workspace id from the authenticated session.
 */
export async function EvidenceList({ workspaceId }: { workspaceId: string }) {
  const findings = await prisma.finding.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      evidence: { some: {} },
      verified: true,
    },
    select: {
      id: true,
      title: true,
      summary: true,
      target: { select: { id: true, name: true, type: true } },
      evidence: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { type: true, createdAt: true },
      },
      _count: { select: { evidence: true } },
    },
    orderBy: { lastSeenAt: "desc" },
    take: 50,
  })

  if (findings.length === 0) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="No verified evidence yet"
        description="Run a review and verify findings to collect evidence records."
        action={
          <Link href="/dashboard/scans" className={buttonVariants()}>
            Start a review
          </Link>
        }
      />
    )
  }

  return (
    <div className="grid gap-3">
      {findings.map((f) => (
        <Link
          key={f.id}
          href={`/dashboard/findings/${f.id}`}
          className="group bg-card hover:border-primary/50 hover:shadow-card-hover block rounded-xl border p-4 transition-colors"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="group-hover:text-primary font-semibold tracking-tight">{f.title}</h3>
              <p className="text-muted-foreground line-clamp-2 text-sm">{f.summary}</p>
              {f.target && <p className="text-muted-foreground mt-1 text-xs">{f.target.name}</p>}
            </div>
            <div className="shrink-0 text-right">
              <span className="bg-primary/10 text-primary inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium">
                {f._count.evidence} record{f._count.evidence === 1 ? "" : "s"}
              </span>
              <p className="text-muted-foreground mt-1 text-xs">
                {evidenceTypeLabel(f.evidence[0]?.type)}
              </p>
            </div>
          </div>
        </Link>
      ))}
    </div>
  )
}

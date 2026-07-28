import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { prisma } from "@lyrashield/db"
import { EmptyState } from "@lyrashield/ui"
import { ShieldCheck, ShieldAlert } from "lucide-react"
import Link from "next/link"

export default async function EvidencePage() {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)

  const findings = workspaceId
    ? await prisma.finding.findMany({
        where: {
          workspaceId,
          deletedAt: null,
          evidence: { some: {} },
          verified: true,
        },
        include: {
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
    : []

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Evidence</h1>
        <p className="text-muted-foreground text-sm">
          Independently verified evidence behind findings.
        </p>
      </div>

      {!workspaceId ? (
        <EmptyState
          icon={ShieldCheck}
          title="No workspace yet"
          description="Create a workspace during onboarding to view evidence."
        />
      ) : findings.length === 0 ? (
        <EmptyState
          icon={ShieldAlert}
          title="No verified evidence yet"
          description="Run a review and verify findings to collect evidence records."
        />
      ) : (
        <div className="grid gap-3">
          {findings.map((f) => (
            <Link
              key={f.id}
              href={`/dashboard/findings/${f.id}`}
              className="group block rounded-xl border bg-card p-4 transition-colors hover:border-primary/50 hover:shadow-card-hover"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-semibold tracking-tight group-hover:text-primary">{f.title}</h3>
                  <p className="text-muted-foreground line-clamp-2 text-sm">{f.summary}</p>
                  {f.target && (
                    <p className="text-muted-foreground mt-1 text-xs">{f.target.name}</p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                    {f._count.evidence} record{f._count.evidence === 1 ? "" : "s"}
                  </span>
                  <p className="text-muted-foreground mt-1 text-xs">{f.evidence[0]?.type}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

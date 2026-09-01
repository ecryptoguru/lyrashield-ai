import type { Metadata } from "next"
import { prisma, listScans } from "@lyrashield/db"
import type { ScanStatus } from "@lyrashield/db"
import { redirect } from "next/navigation"
import { Radar } from "lucide-react"
import { hasPermission, PERMISSIONS } from "@lyrashield/auth"
import { ScansClient } from "./scans-client"
import { SchedulesClient } from "../schedules/schedules-client"
import { getCachedSession, getCachedWorkspaceContext, getCachedWorkspaceId } from "@/lib/cache"
import { RUN_PLURAL, TARGET_PLURAL } from "@/lib/terminology"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { DashboardSectionTabs, type SectionTab } from "@/components/dashboard-section-tabs"
import { parseScanStateFilter, scanStateStatuses } from "@/lib/scan-presentation"

const SCANS_TABS: SectionTab[] = [
  { value: "runs", label: "Runs", href: "/dashboard/scans?tab=runs" },
  { value: "monitoring", label: "Monitoring", href: "/dashboard/scans?tab=monitoring" },
]

function normalizeTab(value: string | undefined): "runs" | "monitoring" {
  return value === "monitoring" ? "monitoring" : "runs"
}

export const metadata: Metadata = {
  title: "Trust Runs",
}

export default async function ScansPage({
  searchParams,
}: {
  searchParams: Promise<{
    new?: string
    tab?: string
    target?: string
    goal?: string
    mode?: string
    state?: string
  }>
}) {
  const session = await getCachedSession()
  if (!session) redirect("/sign-in")

  const [workspaceId, workspaceContext] = await Promise.all([
    getCachedWorkspaceId(session.userId),
    getCachedWorkspaceContext(session.userId),
  ])

  if (!workspaceId) {
    return (
      <div>
        <PageHeader
          title={RUN_PLURAL}
          description={`Run and monitor ${RUN_PLURAL.toLowerCase()} against your ${TARGET_PLURAL.toLowerCase()}`}
        />
        <NoWorkspaceState
          icon={Radar}
          description={`Create a workspace first to start running ${RUN_PLURAL.toLowerCase()}.`}
        />
      </div>
    )
  }

  const params = await searchParams
  const tab = normalizeTab(params.tab)

  const tabs: SectionTab[] = SCANS_TABS

  if (tab === "monitoring") {
    return (
      <div>
        <DashboardSectionTabs
          title={RUN_PLURAL}
          description={`Schedule recurring ${RUN_PLURAL.toLowerCase()} to monitor your ${TARGET_PLURAL.toLowerCase()}`}
          tabs={tabs}
          activeTab={tab}
        />
        <SchedulesClient workspaceId={workspaceId} />
      </div>
    )
  }

  // Filter state is parsed on the server and passed as initial props so the
  // first client render matches the server-rendered HTML (hydration parity).
  const stateFilter = parseScanStateFilter(params.state)
  const limit = 25
  // Scan rows come from listScans so the SSR page and the /api/scans poll share
  // one query shape and one projection — they previously drifted apart.
  const [targets, { items, nextCursor }] = await Promise.all([
    prisma.target.findMany({
      where: { workspaceId, deletedAt: null },
      select: { id: true, name: true, type: true, url: true, apiSpecUrl: true, repoFullName: true },
      orderBy: { name: "asc" },
      take: 200,
    }),
    listScans({
      workspaceId,
      ...(params.target ? { targetId: params.target } : {}),
      ...(scanStateStatuses(stateFilter)
        ? { statuses: scanStateStatuses(stateFilter) as never as ScanStatus[] }
        : {}),
      limit,
    }),
  ])

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
    findingCount: s.findingCount,
    target: s.target,
    createdAt: s.createdAt.toISOString(),
  }))

  const autoOpen = params.new === "1"
  const recoveryTarget = targets.find((target) => target.id === params.target)
  const activeRole = workspaceContext.workspaces.find((w) => w.id === workspaceId)?.role
  const canManageBilling = activeRole
    ? hasPermission(activeRole as never, PERMISSIONS.billing.manage)
    : false

  return (
    <div>
      <DashboardSectionTabs
        title={RUN_PLURAL}
        description={`Run and monitor ${RUN_PLURAL.toLowerCase()} against your ${TARGET_PLURAL.toLowerCase()}`}
        tabs={tabs}
        activeTab={tab}
      />
      <ScansClient
        workspaceId={workspaceId}
        targets={targets.map((t) => ({
          id: t.id,
          name: t.name,
          type: t.type,
          url: t.url,
          apiSpecUrl: t.apiSpecUrl,
          repoFullName: t.repoFullName,
        }))}
        initialData={initialData}
        initialNextCursor={nextCursor}
        initialShowCreate={autoOpen}
        initialTargetId={recoveryTarget?.id}
        initialGoal={params.goal}
        initialMode={params.mode}
        initialStateFilter={stateFilter}
        initialTargetFilter={params.target ?? ""}
        canManageBilling={canManageBilling}
      />
    </div>
  )
}

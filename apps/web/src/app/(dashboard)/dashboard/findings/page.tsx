import { ISSUE_PLURAL, RUN_PLURAL } from "@/lib/terminology"
import { getCachedSession, getCachedWorkspaceId, getCachedFindings } from "@/lib/cache"
import { prisma } from "@lyrashield/db"
import { ShieldAlert } from "lucide-react"
import { FindingsClient, type FindingListItem } from "./findings-client"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { DashboardSectionTabs, type SectionTab } from "@/components/dashboard-section-tabs"
import { EvidenceList } from "./evidence-list"
import { ReportsClient } from "../reports/reports-client"
import { calculateFindingPriority } from "@/lib/finding-priority"

const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
}

const FINDINGS_TABS: SectionTab[] = [
  { value: "issues", label: "Issues", href: "/dashboard/findings?tab=issues" },
  { value: "evidence", label: "Evidence", href: "/dashboard/findings?tab=evidence" },
  { value: "reports", label: "Reports", href: "/dashboard/findings?tab=reports" },
]

type FindingsTab = "issues" | "evidence" | "reports"

function normalizeTab(value: string | undefined): FindingsTab {
  if (value === "evidence" || value === "reports") return value
  return "issues"
}

export default async function FindingsPage({
  searchParams,
}: {
  searchParams: Promise<{ finding?: string; tab?: string; scanId?: string; targetId?: string }>
}) {
  const session = await getCachedSession()
  if (!session) return null

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return (
      <div>
        <PageHeader
          title={ISSUE_PLURAL}
          description={`Potential and verified security ${ISSUE_PLURAL.toLowerCase()} reported by your ${RUN_PLURAL.toLowerCase()}`}
        />
        <NoWorkspaceState
          icon={ShieldAlert}
          description={`Create a workspace during onboarding to view ${ISSUE_PLURAL.toLowerCase()}.`}
        />
      </div>
    )
  }

  const params = await searchParams
  const tab = normalizeTab(params.tab)
  const tabs = FINDINGS_TABS

  const description = `Potential and verified security ${ISSUE_PLURAL.toLowerCase()} reported by your ${RUN_PLURAL.toLowerCase()}`

  if (tab === "evidence") {
    return (
      <div>
        <DashboardSectionTabs
          title={ISSUE_PLURAL}
          description="Independently verified evidence behind findings."
          tabs={tabs}
          activeTab={tab}
        />
        <EvidenceList workspaceId={workspaceId} />
      </div>
    )
  }

  if (tab === "reports") {
    return (
      <div>
        <DashboardSectionTabs
          title={ISSUE_PLURAL}
          description="Create immutable assurance snapshots from completed scan evidence."
          tabs={tabs}
          activeTab={tab}
        />
        <ReportsClient
          workspaceId={workspaceId}
          initialScanId={params.scanId}
          initialTargetId={params.targetId}
        />
      </div>
    )
  }

  const { finding: requestedFindingId } = params
  const [{ items: findings, nextCursor }, requestedFinding] = await Promise.all([
    getCachedFindings(workspaceId),
    requestedFindingId
      ? prisma.finding.findFirst({
          where: { id: requestedFindingId, workspaceId, deletedAt: null },
          select: {
            id: true,
            title: true,
            summary: true,
            severity: true,
            status: true,
            verified: true,
            verificationStatus: true,
            verificationMethod: true,
            verificationReason: true,
            confidence: true,
            cwe: true,
            cvssScore: true,
            businessImpact: true,
            exploitability: true,
            firstSeenAt: true,
            lastSeenAt: true,
            target: { select: { id: true, name: true, type: true, environment: true } },
            _count: {
              select: {
                evidence: { where: { redactionStatus: { not: "deleted" } } },
                fixProposals: { where: { deletedAt: null } },
              },
            },
          },
        })
      : Promise.resolve(null),
  ])
  const visibleFindings =
    requestedFinding && !findings.some((finding) => finding.id === requestedFinding.id)
      ? [requestedFinding, ...findings]
      : findings

  // Page-local priority matches the API list contract: SSR initial data is
  // ranked with the same pure helper so the client's default Priority sort is
  // stable between server render and client hydration.
  const initialData: FindingListItem[] = visibleFindings
    .map((f) => ({
      id: f.id,
      title: f.title,
      summary: f.summary,
      severity: f.severity as FindingListItem["severity"],
      status: f.status,
      verified: f.verified,
      verificationStatus: f.verificationStatus,
      verificationMethod: f.verificationMethod,
      verificationReason: f.verificationReason,
      confidence: f.confidence,
      cwe: f.cwe,
      cvssScore: f.cvssScore,
      businessImpact: f.businessImpact,
      exploitability: f.exploitability,
      target: f.target,
      _count: f._count,
      firstSeenAt: f.firstSeenAt.toISOString(),
      lastSeenAt: f.lastSeenAt.toISOString(),
      priority: calculateFindingPriority({
        severity: f.severity,
        status: f.status,
        verified: f.verified,
        confidence: f.confidence,
        environment: f.target?.environment as
          "LOCAL" | "PREVIEW" | "STAGING" | "PRODUCTION" | null | undefined,
        businessImpact: f.businessImpact,
        exploitability: f.exploitability,
      }),
    }))
    .sort(
      (left, right) =>
        right.priority.score - left.priority.score ||
        (SEVERITY_ORDER[left.severity] ?? 99) - (SEVERITY_ORDER[right.severity] ?? 99) ||
        new Date(right.lastSeenAt).getTime() - new Date(left.lastSeenAt).getTime()
    )

  return (
    <div>
      <DashboardSectionTabs
        title={ISSUE_PLURAL}
        description={description}
        tabs={tabs}
        activeTab={tab}
      />
      <FindingsClient
        workspaceId={workspaceId}
        initialData={initialData}
        initialNextCursor={nextCursor}
        initialSelectedFindingId={requestedFindingId}
      />
    </div>
  )
}

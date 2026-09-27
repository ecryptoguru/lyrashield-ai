import type { Metadata } from "next"
import { hasPermission, PERMISSIONS } from "@lyrashield/auth"
import { ISSUE_PLURAL, RUN_PLURAL } from "@/lib/terminology"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { prisma, listFindings, findingScopeWhere, validateFindingScope } from "@lyrashield/db"
import { ShieldAlert } from "lucide-react"
import { FindingsClient, type FindingListItem } from "./findings-client"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { DashboardSectionTabs, type SectionTab } from "@/components/dashboard-section-tabs"
import { EvidenceList } from "./evidence-list"
import { FixesClient } from "./fixes-client"
import { calculateFindingPriority } from "@/lib/finding-priority"
import {
  findingFilterToApiQuery,
  findingsHref,
  parseFindingListParams,
} from "@/lib/finding-list-params"
import { listFixProposals } from "@lyrashield/db"
import Link from "next/link"
import { EmptyState, buttonVariants } from "@lyrashield/ui"

const FINDINGS_TABS: SectionTab[] = [
  // The `issues` tab value is a compatibility URL parameter; the visible label
  // uses the canonical "Findings" noun. Reports are a direct destination at
  // /dashboard/reports (W2-10); the old tab route forwards its query scope.
  { value: "issues", label: ISSUE_PLURAL, href: "/dashboard/findings?tab=issues" },
  { value: "evidence", label: "Evidence", href: "/dashboard/findings?tab=evidence" },
  // Deep Review v16 3.2: proposed fixes are a view of findings, not an
  // independent destination. /dashboard/fixes forwards here.
  { value: "fixes", label: "Proposed fixes", href: "/dashboard/findings?tab=fixes" },
]

type FindingsTab = "issues" | "evidence" | "fixes"

function normalizeTab(value: string | undefined): FindingsTab {
  if (value === "evidence") return value
  if (value === "fixes") return value
  // The legacy reports tab is a permanent redirect to /dashboard/reports.
  return "issues"
}

export const metadata: Metadata = {
  title: ISSUE_PLURAL,
}

function FindingsScopeStrip({
  available,
  scoped,
  scanId,
  targetName,
}: {
  available: boolean
  scoped: boolean
  scanId: string
  targetName?: string
}) {
  return (
    <div
      aria-label="Findings scope"
      className="mb-5 flex flex-col gap-2 rounded-lg border bg-card px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <p>
        <span className="font-medium">Scope:</span>{" "}
        {!available ? (
          <span role="alert">Selected scan or target is unavailable in this workspace.</span>
        ) : scoped ? (
          <span>
            {targetName ? `Target: ${targetName}` : "All targets"}
            {scanId ? " · Single scan" : ""}
          </span>
        ) : (
          <span>All workspace findings</span>
        )}
      </p>
      {scoped && (
        <Link
          href={findingsHref({ tab: "issues" })}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          All workspace findings
        </Link>
      )}
    </div>
  )
}

export default async function FindingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    finding?: string
    tab?: string
    scanId?: string
    targetId?: string
    filter?: string
    sort?: string
    target?: string
    q?: string
  }>
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
  // Filter/sort/search are parsed on the server and passed as initial props so
  // the server-rendered tree and the client's first render match exactly.
  const listParams = parseFindingListParams(params)
  const tabs = FINDINGS_TABS.map((sectionTab) => ({
    ...sectionTab,
    href: findingsHref({
      tab: sectionTab.value,
      scanId: params.scanId,
      target: params.target,
      targetId: params.targetId,
    }),
  }))
  const scope = listParams.scopeValid
    ? await validateFindingScope({
        workspaceId,
        ...(listParams.target ? { targetId: listParams.target } : {}),
        ...(listParams.scanId ? { observedInScanId: listParams.scanId } : {}),
      })
    : { available: false as const, target: null, scanId: null }
  const effectiveTargetId = scope.available ? (scope.target?.id ?? "") : ""
  const scoped = Boolean(listParams.scanId || listParams.target || params.targetId !== undefined)
  const renderHeader = (description: string) => (
    <>
      <DashboardSectionTabs
        title={ISSUE_PLURAL}
        description={description}
        tabs={tabs}
        activeTab={tab}
        preserveSearchParams={["scanId", "target", "targetId"]}
      />
      {(!scope.available || tab !== "issues") && (
        <FindingsScopeStrip
          available={scope.available}
          scoped={scoped}
          scanId={scope.available ? (scope.scanId ?? "") : listParams.scanId}
          targetName={scope.available ? (scope.target?.name ?? undefined) : undefined}
        />
      )}
    </>
  )

  const description = `Potential and verified security ${ISSUE_PLURAL.toLowerCase()} reported by your ${RUN_PLURAL.toLowerCase()}`

  if (!scope.available) {
    return (
      <div>
        {renderHeader(description)}
        <EmptyState
          icon={ShieldAlert}
          title="Findings scope unavailable"
          description="The selected scan or target is unavailable in this workspace. Clear the scope to continue."
          action={
            <Link href={findingsHref({ tab: "issues" })} className={buttonVariants()}>
              All workspace findings
            </Link>
          }
        />
      </div>
    )
  }

  if (tab === "evidence") {
    return (
      <div>
        {renderHeader("Independently verified evidence behind findings.")}
        <EvidenceList
          key={`${workspaceId}:${listParams.scanId}:${effectiveTargetId}`}
          workspaceId={workspaceId}
          {...(effectiveTargetId ? { targetId: effectiveTargetId } : {})}
          {...(listParams.scanId ? { observedInScanId: listParams.scanId } : {})}
        />
      </div>
    )
  }

  if (tab === "fixes") {
    const { items: fixProposals, nextCursor: fixProposalsCursor } = await listFixProposals({
      workspaceId,
      ...(effectiveTargetId ? { targetId: effectiveTargetId } : {}),
      ...(listParams.scanId ? { observedInScanId: listParams.scanId } : {}),
      limit: 20,
    })
    const initialFixes = fixProposals.map((p) => ({
      id: p.id,
      kind: p.kind,
      summary: p.summary,
      status: p.status,
      safetyScore: p.safetyScore,
      generatedByModel: p.generatedByModel,
      createdAt: p.createdAt.toISOString(),
      finding: {
        id: p.finding.id,
        title: p.finding.title,
        severity: p.finding.severity,
        status: p.finding.status,
        cwe: p.finding.cwe,
        target: p.finding.target,
      },
      pullRequests: p.pullRequests.map((pr) => ({
        id: pr.id,
        provider: pr.provider,
        repoOwner: pr.repoOwner,
        repoName: pr.repoName,
        branchName: pr.branchName,
        prNumber: pr.prNumber,
        prUrl: pr.prUrl,
        status: pr.status,
      })),
    }))
    return (
      <div>
        {renderHeader("Proposed fixes for these findings, with their pull requests.")}
        <FixesClient
          key={`${workspaceId}:${listParams.scanId}:${effectiveTargetId}`}
          workspaceId={workspaceId}
          {...(effectiveTargetId ? { targetId: effectiveTargetId } : {})}
          {...(listParams.scanId ? { observedInScanId: listParams.scanId } : {})}
          initialData={initialFixes}
          initialNextCursor={fixProposalsCursor}
        />
      </div>
    )
  }

  const { finding: requestedFindingId } = params
  const [{ items: findings, nextCursor }, targets, requestedFinding] = await Promise.all([
    listFindings({
      workspaceId,
      ...findingFilterToApiQuery(listParams.filter),
      ...(effectiveTargetId ? { targetId: effectiveTargetId } : {}),
      ...(listParams.scanId ? { observedInScanId: listParams.scanId } : {}),
      ...(listParams.q ? { q: listParams.q } : {}),
      limit: 25,
    }),
    prisma.target.findMany({
      where: { workspaceId, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 200,
    }),
    requestedFindingId
      ? prisma.finding.findFirst({
          where: {
            id: requestedFindingId,
            ...findingScopeWhere({
              workspaceId,
              ...(effectiveTargetId ? { targetId: effectiveTargetId } : {}),
              ...(listParams.scanId ? { observedInScanId: listParams.scanId } : {}),
            }),
          },
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

  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: session.userId } },
    select: { role: true, status: true },
  })
  return (
    <div>
      {renderHeader(description)}
      <FindingsClient
        key={`${workspaceId}:${listParams.scanId}:${effectiveTargetId}`}
        canCreatePr={
          membership?.status === "active" &&
          hasPermission(membership.role, PERMISSIONS.fix.createPr)
        }
        workspaceId={workspaceId}
        initialData={initialData}
        initialNextCursor={nextCursor}
        initialSelectedFindingId={requestedFinding?.id}
        initialScanId={listParams.scanId}
        initialFilter={listParams.filter}
        initialSort={listParams.sort}
        initialTargetFilter={effectiveTargetId}
        initialQuery={listParams.q}
        targets={targets}
      />
    </div>
  )
}

const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
}

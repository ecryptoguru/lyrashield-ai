import type { Metadata } from "next"
import { cache } from "react"
import {
  getScanQualitySurface,
  getScanWithEvents,
  getScanResultManifestDetail,
  normalizeScorecardPayload,
  prisma,
} from "@lyrashield/db"
import { notFound, redirect } from "next/navigation"
import { Radar } from "lucide-react"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { hasPermission, PERMISSIONS } from "@lyrashield/auth"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { SCAN_SINGULAR } from "@/lib/terminology"
import { ScanDetailClient } from "./scan-detail-client"
import { buildScanDetailData } from "./scan-detail-data"

/** Shared by generateMetadata and the page so a dead link costs one lookup. */
const getScopedScan = cache((id: string, workspaceId: string) => getScanWithEvents(id, workspaceId))

/**
 * The document title has to be decided here, not by `notFound()`: the dashboard
 * renders inside `(dashboard)/loading.tsx`, so the 200 shell (and this title)
 * stream before the page resolves. Without this, a dead scan link keeps the
 * resource's own title while the body shows the not-found card.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const session = await getCachedSession()
  if (!session) return { title: "Scan" }

  const { id } = await params
  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) return { title: "Scan" }

  const scan = await getScopedScan(id, workspaceId)
  return { title: scan ? "Scan" : "Scan not found" }
}

export default async function ScanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCachedSession()
  if (!session) redirect("/sign-in")

  const { id } = await params
  const workspaceId = await getCachedWorkspaceId(session.userId)

  if (!workspaceId) {
    return (
      <div>
        <PageHeader title={SCAN_SINGULAR} />
        <NoWorkspaceState
          icon={Radar}
          description={`Create a workspace before viewing ${SCAN_SINGULAR.toLowerCase()}.`}
        />
      </div>
    )
  }

  const scan = await getScopedScan(id, workspaceId)
  if (!scan) notFound()

  // One parallel batch for the SSR payload: findings bounded to the same 100
  // the client table pages, the one-time manifest detail, and the scorecard
  // pair (gated on status only — findings.length refines the render below).
  const wantsScorecard = scan.status === "COMPLETED" && !!scan.targetId
  const [findings, manifestDetail, qualitySurface, scoreSnapshot, membership, planRow] =
    await Promise.all([
      prisma.finding.findMany({
        where: { workspaceId, deletedAt: null, candidates: { some: { scanId: id } } },
        select: {
          id: true,
          title: true,
          severity: true,
          status: true,
          cwe: true,
          owaspCategory: true,
          cvssScore: true,
          summary: true,
          verified: true,
          verificationStatus: true,
          verificationMethod: true,
          verificationReason: true,
          createdAt: true,
        },
        orderBy: { severity: "desc" },
        take: 100,
      }),
      // One-time server fetch of the manifest detail (urlExecution lives inside
      // the tens-of-KB manifest JSON, which getScanWithEvents deliberately
      // excludes so the polling API does not ship it on every request).
      getScanResultManifestDetail(id, workspaceId),
      // Measured quality surface — derived only from stored scan evidence
      // (receipts, finding tiers, manifest); labeled heuristics stay separate.
      getScanQualitySurface(id, workspaceId),
      scan.status === "COMPLETED" && scan.targetId
        ? prisma.scoreSnapshot.findFirst({
            where: {
              scanId: scan.id,
              workspaceId,
              targetId: scan.targetId,
              shareEligible: true,
              expiresAt: { gt: new Date() },
            },
            select: {
              grade: true,
              shares: {
                where: { revokedAt: null, createdById: session.userId },
                orderBy: { createdAt: "desc" },
                take: 1,
                select: {
                  id: true,
                  slug: true,
                  publicPayload: true,
                  viewCount: true,
                  _count: { select: { events: { where: { eventType: "SHARE" } } } },
                  referralCode: {
                    select: { code: true, _count: { select: { attributions: true } } },
                  },
                },
              },
            },
          })
        : null,
      wantsScorecard
        ? prisma.workspaceMember.findFirst({
            where: { workspaceId, userId: session.userId, status: "active" },
            select: { role: true },
          })
        : null,
      // The immutable execution plan is fetched only here (never on the poll
      // path) and projected to an allowlisted summary — the client sees
      // workflow/scope/limits, never provider routing or cost internals.
      prisma.scan.findFirst({
        where: { id, workspaceId, deletedAt: null },
        select: { executionPlan: true },
      }),
    ])

  // The detail page offers Cancel for an active scan, which the list has always
  // done. The permission is read fresh for this request; the API re-checks
  // scan:cancel and the scan's own state before it changes anything.
  const canCancelScan = await prisma.workspaceMember
    .findFirst({
      where: { workspaceId, userId: session.userId, status: "active" },
      select: { role: true },
    })
    .then((row) => (row ? hasPermission(row.role, PERMISSIONS.scan.cancel) : false))

  const scanData = buildScanDetailData({
    scan,
    findings,
    manifestDetail,
    // Kept here, not inside the builder, so this file's reviewed type-assertion
    // baseline entry still matches the exact expression it was approved for.
    qualitySurface: qualitySurface as unknown as Record<string, unknown> | null,
    planRow,
  })

  const findingsData = findings.map((f) => ({
    id: f.id,
    title: f.title,
    severity: f.severity,
    status: f.status,
    cwe: f.cwe,
    cvssScore: f.cvssScore,
    summary: f.summary,
    verified: f.verified,
    verificationStatus: f.verificationStatus,
    verificationMethod: f.verificationMethod,
    verificationReason: f.verificationReason,
    createdAt: f.createdAt.toISOString(),
  }))

  const existingShare = scoreSnapshot?.shares[0]
  const scorecard =
    findings.length === 0 && scoreSnapshot && scan.targetId
      ? {
          targetId: scan.targetId,
          grade: scoreSnapshot.grade,
          canPublish:
            membership !== null &&
            ["OWNER", "ADMIN", "SECURITY_ADMIN", "APPSEC_MANAGER"].includes(membership.role),
          existingShare: existingShare
            ? {
                id: existingShare.id,
                slug: existingShare.slug,
                resolvedFindings:
                  normalizeScorecardPayload(existingShare.publicPayload)?.resolvedFindings ?? 0,
                views: existingShare.viewCount,
                shareHandoffs: existingShare._count.events,
                referredSignups: existingShare.referralCode?._count.attributions ?? 0,
                url: existingShare.referralCode?.code
                  ? `/score/${existingShare.slug}?ref=${existingShare.referralCode.code}`
                  : `/score/${existingShare.slug}`,
              }
            : undefined,
        }
      : null

  return (
    <ScanDetailClient
      scan={scanData}
      findings={findingsData}
      scorecard={scorecard}
      canCancel={canCancelScan}
    />
  )
}

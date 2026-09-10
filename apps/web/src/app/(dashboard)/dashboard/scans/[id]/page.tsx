import type { Metadata } from "next"
import { getScanWithEvents, getScanResultManifestDetail, prisma } from "@lyrashield/db"
import { redirect } from "next/navigation"
import { Radar } from "lucide-react"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { RUN_SINGULAR } from "@/lib/terminology"
import { ScanDetailClient } from "./scan-detail-client"

export const metadata: Metadata = {
  title: "Scan",
}

export default async function ScanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCachedSession()
  if (!session) redirect("/sign-in")

  const { id } = await params
  const workspaceId = await getCachedWorkspaceId(session.userId)

  if (!workspaceId) {
    return (
      <div>
        <PageHeader title={RUN_SINGULAR} />
        <NoWorkspaceState
          icon={Radar}
          description={`Create a workspace before viewing ${RUN_SINGULAR.toLowerCase()}.`}
        />
      </div>
    )
  }

  const scan = await getScanWithEvents(id, workspaceId)
  if (!scan) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <h2 className="mb-2 text-lg font-semibold">Scan not found</h2>
        <p className="text-muted-foreground text-sm">
          This scan may have been deleted or you don&apos;t have access to it.
        </p>
      </div>
    )
  }

  const findings = await prisma.finding.findMany({
    where: { scanId: id, workspaceId, deletedAt: null },
    select: {
      id: true,
      title: true,
      severity: true,
      status: true,
      cwe: true,
      cvssScore: true,
      summary: true,
      verified: true,
      verificationStatus: true,
      verificationMethod: true,
      verificationReason: true,
      createdAt: true,
    },
    orderBy: { severity: "desc" },
  })

  const [scoreSnapshot, membership] =
    scan.status === "COMPLETED" && findings.length === 0 && scan.targetId
      ? await Promise.all([
          prisma.scoreSnapshot.findFirst({
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
          }),
          prisma.workspaceMember.findFirst({
            where: { workspaceId, userId: session.userId, status: "active" },
            select: { role: true },
          }),
        ])
      : [null, null]

  // One-time server fetch of the manifest detail (urlExecution lives inside the
  // tens-of-KB manifest JSON, which getScanWithEvents deliberately excludes so
  // the polling API does not ship it on every request).
  const manifestDetail = await getScanResultManifestDetail(id, workspaceId)

  const target = scan.target

  const scanData = {
    id: scan.id,
    workspaceId: scan.workspaceId,
    status: scan.status,
    goal: scan.goal,
    mode: scan.mode,
    triggerType: scan.triggerType,
    startedAt: scan.startedAt ? scan.startedAt.toISOString() : null,
    endedAt: scan.endedAt ? scan.endedAt.toISOString() : null,
    summary: scan.summary,
    errorCategory: scan.errorCategory,
    errorMessage: scan.errorMessage,
    createdAt: scan.createdAt.toISOString(),
    target: target
      ? {
          id: target.id,
          name: target.name,
          type: target.type,
          url: target.url,
          repoFullName: target.repoFullName,
        }
      : null,
    events: scan.events.map((e) => ({
      id: e.id,
      stage: e.stage,
      level: e.level,
      message: e.message,
      metadata:
        e.metadata && typeof e.metadata === "object" && !Array.isArray(e.metadata)
          ? (e.metadata as Record<string, unknown>)
          : null,
      createdAt: e.createdAt.toISOString(),
    })),
    integrity: {
      manifestChecksum: manifestDetail?.checksum ?? scan.resultManifest?.checksum ?? null,
      urlExecution: manifestDetail?.urlExecution ?? null,
      coverage: scan.coverageReceipts.map((receipt) => ({
        scanner: receipt.scanner,
        controlId: receipt.controlId,
        status: receipt.status,
        reason: receipt.reason,
        subject: receipt.subject,
        metadata:
          receipt.metadata &&
          typeof receipt.metadata === "object" &&
          !Array.isArray(receipt.metadata)
            ? (receipt.metadata as Record<string, unknown>)
            : null,
      })),
    },
    aiSecurity: scan.aiSecurityScoreSnapshot
      ? {
          score: scan.aiSecurityScoreSnapshot.score,
          methodology: scan.aiSecurityScoreSnapshot.methodology,
          assessedCount: scan.aiSecurityScoreSnapshot.assessedCount,
          totalControls: scan.aiSecurityScoreSnapshot.totalControls,
          evidenceQuality:
            scan.aiSecurityScoreSnapshot.evidenceQuality &&
            typeof scan.aiSecurityScoreSnapshot.evidenceQuality === "object" &&
            !Array.isArray(scan.aiSecurityScoreSnapshot.evidenceQuality)
              ? (scan.aiSecurityScoreSnapshot.evidenceQuality as Record<string, number>)
              : null,
          reason:
            (scan.aiSecurityScoreSnapshot.breakdown as { reason?: string } | null)?.reason ?? null,
          ai03: (scan.aiSecurityScoreSnapshot.breakdown as { ai03?: unknown } | null)?.ai03 ?? null,
          triage:
            (scan.aiSecurityScoreSnapshot.breakdown as { triage?: unknown } | null)?.triage ?? null,
          computedAt: scan.aiSecurityScoreSnapshot.computedAt.toISOString(),
        }
      : null,
  }

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
    scoreSnapshot && scan.targetId
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
                resolvedFindings: (
                  existingShare.publicPayload as unknown as { resolvedFindings: number }
                ).resolvedFindings,
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

  return <ScanDetailClient scan={scanData} findings={findingsData} scorecard={scorecard} />
}

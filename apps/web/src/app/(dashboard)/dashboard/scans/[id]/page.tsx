import type { Metadata } from "next"
import { cache } from "react"
import {
  getScanQualitySurface,
  getScanWithEvents,
  getScanResultManifestDetail,
  prisma,
} from "@lyrashield/db"
import { ScanExecutionPlanSchema } from "@lyrashield/types"
import { defaultStandards, renderStandards } from "@lyrashield/security"
import { notFound, redirect } from "next/navigation"
import { Radar } from "lucide-react"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"
import { RUN_SINGULAR } from "@/lib/terminology"
import { ScanDetailClient } from "./scan-detail-client"

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
        <PageHeader title={RUN_SINGULAR} />
        <NoWorkspaceState
          icon={Radar}
          description={`Create a workspace before viewing ${RUN_SINGULAR.toLowerCase()}.`}
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
      where: { scanId: id, workspaceId, deletedAt: null },
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

  const target = scan.target

  const planParsed = planRow?.executionPlan
    ? ScanExecutionPlanSchema.safeParse(planRow.executionPlan)
    : null
  const plan = planParsed?.success === true ? planParsed.data : null
  const executionPlan = plan
    ? {
        workflow: plan.workflow,
        targetType: plan.targetType,
        depth: plan.depth,
        scope: plan.scope,
        profileId: plan.profileId,
        sourceRevision: plan.source?.revision ?? null,
        baseRevision: plan.source?.baseRevision ?? null,
        // Minutes only — never provider cost internals.
        maxDurationMinutes: Math.round(plan.limits.maxDurationMs / 60_000),
        maxRequests: plan.limits.maxRequests ?? null,
        attachmentCount: plan.attachmentIds.length,
        authorizationRequired: Boolean(plan.authorizationRef),
        capabilities: plan.capabilities,
      }
    : null

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
    executionPlan,
    integrity: {
      manifestChecksum: manifestDetail?.checksum ?? scan.resultManifest?.checksum ?? null,
      urlExecution: manifestDetail?.urlExecution ?? null,
      scopedCoverage: manifestDetail?.scopedCoverage ?? null,
      threatModel: manifestDetail?.threatModel ?? null,
      attachments: manifestDetail?.attachments ?? null,
      ingestionWarnings: manifestDetail?.ingestionWarnings ?? [],
      quality: qualitySurface as unknown as Record<string, unknown> | null,
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
      standards: renderStandards(
        defaultStandards(),
        scan.coverageReceipts,
        findings.map((f) => ({ cwe: f.cwe, owaspCategory: f.owaspCategory }))
      ),
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

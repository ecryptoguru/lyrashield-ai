import { ScanExecutionPlanSchema } from "@lyrashield/types"
import { defaultStandards, renderStandards } from "@lyrashield/security"
import type { getScanResultManifestDetail, getScanWithEvents } from "@lyrashield/db"
import { filterDashboardScanEvents } from "@/lib/scan-event-visibility"

/**
 * The SSR projection of a scan row into the client payload. It was the middle of
 * ScanDetailPage and moved here unchanged so that page stays inside the size
 * ratchet. Same allowlisted fields, same event filtering, same standards
 * rendering — the projection only ever exposes what the page already exposed.
 *
 * The row shape is inferred from the `@lyrashield/db` function the page already
 * calls, so this module cannot drift from the real return type.
 */
type ScopedScan = Awaited<ReturnType<typeof getScanWithEvents>>
type ManifestDetail = Awaited<ReturnType<typeof getScanResultManifestDetail>>

export function buildScanDetailData({
  scan,
  findings,
  manifestDetail,
  qualitySurface,
  planRow,
}: {
  scan: NonNullable<ScopedScan>
  findings: Array<{ cwe: string | null; owaspCategory: string | null }>
  manifestDetail: ManifestDetail
  /**
   * Already projected to a plain record by the caller. The double-unknown
   * assertion lives in the page module so the type-assertion baseline entry for
   * that file still matches.
   */
  qualitySurface: Record<string, unknown> | null
  planRow: { executionPlan: unknown } | null
}) {
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
    events: filterDashboardScanEvents(scan.events).map((e) => ({
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
      quality: qualitySurface,
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

  return scanData
}

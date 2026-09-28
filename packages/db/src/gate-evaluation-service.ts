import {
  computeGateVerdict,
  computeInputChecksum,
  computeVerdictChecksum,
  requiredScannersForTarget,
  isTargetTypeCovered,
  type GateEvidenceInput,
  type GateVerdictResult,
} from "@lyrashield/gate"
import {
  fingerprintPolicy,
  isTrustedRetestReceipt,
  snapshotFromManifest,
  toEpochMs,
} from "./gate-assessment"
import { withWorkspaceRLS } from "./rls"

export interface GateEvaluationResult {
  verdict: GateVerdictResult
  gateVerdictId: string
  /** Present when the gate could not evaluate at all (e.g. no completed scan). */
  note?: string
}

/**
 * Evaluate the Launch Gate for a target and persist the verdict.
 *
 * Returns null when the workspace has no such target. Throws nothing on a
 * target with no completed scan — that is a valid INSUFFICIENT_EVIDENCE path,
 * not an error.
 */
export async function evaluateGateForTarget(
  workspaceId: string,
  targetId: string
): Promise<GateEvaluationResult | null> {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const target = await tx.target.findFirst({
      where: { id: targetId, workspaceId, deletedAt: null },
      select: { id: true, type: true },
    })
    if (!target) return null

    const latestCompletedScan = await tx.scan.findFirst({
      where: { workspaceId, targetId, status: "COMPLETED", deletedAt: null },
      orderBy: { endedAt: "desc" },
      select: {
        id: true,
        endedAt: true,
        status: true,
        mode: true,
        policyId: true,
        resultManifest: { select: { version: true, checksum: true, manifest: true } },
      },
    })

    const policy = latestCompletedScan?.policyId
      ? await tx.policy.findFirst({
          where: { id: latestCompletedScan.policyId, workspaceId, deletedAt: null },
          select: {
            id: true,
            workspaceId: true,
            name: true,
            description: true,
            scanWindow: true,
            blockedPaths: true,
            allowedDomains: true,
            rateLimit: true,
            networkEgressPolicy: true,
            destructiveTestsAllowed: true,
            approvalRequired: true,
            maxBudgetUsd: true,
            maxDurationMinutes: true,
            piiRedactionEnabled: true,
            evidenceRetentionDays: true,
          },
        })
      : null
    const policyFingerprint = fingerprintPolicy(policy as Record<string, unknown> | null)
    const assessmentSnapshot = latestCompletedScan
      ? snapshotFromManifest({
          scanId: latestCompletedScan.id,
          endedAt: latestCompletedScan.endedAt,
          policyId: latestCompletedScan.policyId,
          policyFingerprint,
          manifest: latestCompletedScan.resultManifest,
        })
      : null

    const coverageReceipts = latestCompletedScan
      ? await tx.scanCoverageReceipt.findMany({
          where: { scanId: latestCompletedScan.id },
          select: { controlId: true, scanner: true, status: true, reason: true },
        })
      : []

    const findings = await tx.finding.findMany({
      where: { workspaceId, targetId, deletedAt: null },
      select: {
        id: true,
        severity: true,
        status: true,
        verificationStatus: true,
        lastSeenAt: true,
        scanId: true,
        disposition: true,
        dispositionActorUserId: true,
        dispositionReason: true,
        dispositionAssessmentId: true,
        dispositionAt: true,
        canonicalFindingId: true,
        verificationReceipts: {
          where: { status: { in: ["VALIDATED", "VERIFIED"] } },
          select: {
            status: true,
            method: true,
            scanId: true,
            verifierVersion: true,
            evidence: true,
          },
        },
      },
    })

    const preparedFindings = findings.map((finding) => {
      const trustedRetest = finding.verificationReceipts.some((receipt) =>
        isTrustedRetestReceipt(receipt, finding.scanId)
      )
      const positiveReceipt = latestCompletedScan
        ? finding.verificationReceipts.some(
            (receipt) =>
              receipt.scanId === latestCompletedScan.id &&
              (receipt.status === "VALIDATED" || receipt.status === "VERIFIED") &&
              Boolean(receipt.method)
          )
        : false
      const applicableDisposition =
        Boolean(finding.dispositionActorUserId) &&
        Boolean(finding.dispositionReason) &&
        Boolean(finding.dispositionAt) &&
        finding.dispositionAssessmentId === latestCompletedScan?.id &&
        (finding.disposition === "ACCEPTED_RISK" || finding.disposition === "FALSE_POSITIVE")
      return { finding, trustedRetest, positiveReceipt, applicableDisposition }
    })
    const byFindingId = new Map(preparedFindings.map((entry) => [entry.finding.id, entry]))
    const duplicateResolved = (
      entry: (typeof preparedFindings)[number],
      seen = new Set<string>()
    ): boolean => {
      if (entry.trustedRetest || entry.applicableDisposition) return true
      if (entry.finding.status !== "DUPLICATE" || !entry.finding.canonicalFindingId) return false
      if (seen.has(entry.finding.id)) return false
      seen.add(entry.finding.id)
      const canonical = byFindingId.get(entry.finding.canonicalFindingId)
      return canonical ? duplicateResolved(canonical, seen) : false
    }

    const evidence: GateEvidenceInput = {
      targetId,
      latestCompletedScan: latestCompletedScan
        ? {
            id: latestCompletedScan.id,
            endedAtMs: toEpochMs(latestCompletedScan.endedAt),
            status: latestCompletedScan.status,
            mode: latestCompletedScan.mode,
          }
        : null,
      coverageReceipts: coverageReceipts.map((r) => ({
        controlId: r.controlId,
        scanner: r.scanner,
        status: r.status as GateEvidenceInput["coverageReceipts"][number]["status"],
        reason: r.reason,
      })),
      findings: preparedFindings.map((entry) => ({
        id: entry.finding.id,
        severity: entry.finding.severity,
        status: entry.finding.status,
        verificationStatus: entry.finding.verificationStatus,
        retestConfirmedResolved: entry.finding.status === "FIXED" && entry.trustedRetest,
        hasPositiveEvidence: entry.positiveReceipt || entry.trustedRetest,
        hasApplicableDisposition: entry.applicableDisposition,
        applicableDisposition: entry.applicableDisposition
          ? (entry.finding.disposition as "ACCEPTED_RISK" | "FALSE_POSITIVE")
          : null,
        duplicateCanonicalResolved: duplicateResolved(entry),
        lastSeenAtMs: entry.finding.lastSeenAt.getTime(),
      })),
      requiredScanners: isTargetTypeCovered(target.type)
        ? requiredScannersForTarget(target.type, latestCompletedScan?.mode)
        : [],
      targetTypeCovered: isTargetTypeCovered(target.type),
      policyFingerprint,
      assessmentIdentityComplete: Boolean(assessmentSnapshot),
    }

    const verdict = computeGateVerdict(evidence)
    const inputChecksum = computeInputChecksum(evidence)
    const verdictChecksum = computeVerdictChecksum(verdict)

    const record = await tx.gateVerdict.create({
      data: {
        workspaceId,
        targetId,
        scanId: latestCompletedScan?.id ?? null,
        standardVersion: verdict.standardVersion,
        state: verdict.state,
        coverageStatement: verdict.coverageStatement,
        nonCoverage: verdict.nonCoverage,
        blockingReasons: verdict.blockingReasons,
        evidenceSummary: verdict.evidenceSummary,
        staleness: verdict.staleness,
        inputChecksum,
        verdictChecksum,
        assessmentVersion: assessmentSnapshot?.version ?? null,
        assessmentSnapshot: assessmentSnapshot ?? undefined,
      },
      select: { id: true },
    })

    return { verdict, gateVerdictId: record.id }
  })
}

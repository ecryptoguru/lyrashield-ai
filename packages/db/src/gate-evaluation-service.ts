import { isDeepStrictEqual } from "node:util"
import {
  computeGateVerdict,
  computeInputChecksum,
  computeVerdictChecksum,
  requiredScannersForTarget,
  isTargetTypeCovered,
  type GateEvidenceInput,
  type GateVerdictResult,
  type GateAssessmentSnapshot,
} from "@lyrashield/gate"
import { fingerprintPolicy, snapshotFromManifest, toEpochMs } from "./gate-assessment"
import { loadGateFindings, prepareGateFindingInputs } from "./gate-retest-input"
import { withWorkspaceRLS, type ScopedTransaction } from "./rls"

export interface GateEvaluationResult {
  verdict: GateVerdictResult
  gateVerdictId: string
  /** Present when the gate could not evaluate at all (e.g. no completed scan). */
  note?: string
}

async function persistGateEvaluation(
  tx: ScopedTransaction,
  context: {
    workspaceId: string
    targetId: string
    scanId: string | null
    assessmentSnapshot: GateAssessmentSnapshot | null
    reuseEquivalentVerdict: boolean
  },
  evidence: GateEvidenceInput,
  verdict: GateVerdictResult
) {
  const data = {
    workspaceId: context.workspaceId,
    targetId: context.targetId,
    scanId: context.scanId,
    standardVersion: verdict.standardVersion,
    state: verdict.state,
    coverageStatement: verdict.coverageStatement,
    nonCoverage: verdict.nonCoverage,
    blockingReasons: verdict.blockingReasons,
    evidenceSummary: verdict.evidenceSummary,
    staleness: verdict.staleness,
    inputChecksum: computeInputChecksum(evidence),
    verdictChecksum: computeVerdictChecksum(verdict),
    assessmentVersion: context.assessmentSnapshot?.version ?? null,
    assessmentSnapshot: context.assessmentSnapshot ?? undefined,
  }
  if (context.reuseEquivalentVerdict) {
    const existing = await tx.gateVerdict.findFirst({
      where: { workspaceId: data.workspaceId, targetId: data.targetId },
      orderBy: [{ evaluatedAt: "desc" }, { id: "desc" }],
    })
    // Compare every persisted input, verdict field and assessment binding,
    // rather than trusting the stored state or its claimed checksums alone.
    if (
      existing &&
      Object.entries(data).every(([field, value]) =>
        isDeepStrictEqual(existing[field as keyof typeof existing] ?? null, value ?? null)
      )
    ) {
      return { id: existing.id }
    }
  }
  return tx.gateVerdict.create({ data, select: { id: true } })
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
  targetId: string,
  options: { transaction?: ScopedTransaction; reuseEquivalentVerdict?: boolean } = {}
): Promise<GateEvaluationResult | null> {
  // Packet issuance supplies its RepeatableRead transaction so assessment and
  // remediation observe the same evidence without opening a nested transaction.
  const runConsistent = (fn: (tx: ScopedTransaction) => Promise<GateEvaluationResult | null>) =>
    options.transaction
      ? fn(options.transaction)
      : withWorkspaceRLS(workspaceId, fn, { isolationLevel: "RepeatableRead" })
  return runConsistent(async (tx) => {
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

    const { findings, trustedRetests } = await loadGateFindings(tx, workspaceId, targetId)

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
      findings: prepareGateFindingInputs(findings, trustedRetests, latestCompletedScan?.id ?? null),
      requiredScanners: isTargetTypeCovered(target.type)
        ? requiredScannersForTarget(target.type, latestCompletedScan?.mode)
        : [],
      targetTypeCovered: isTargetTypeCovered(target.type),
      policyFingerprint,
      assessmentIdentityComplete: Boolean(assessmentSnapshot),
    }

    const verdict = computeGateVerdict(evidence)
    const record = await persistGateEvaluation(
      tx,
      {
        workspaceId,
        targetId,
        scanId: latestCompletedScan?.id ?? null,
        assessmentSnapshot,
        reuseEquivalentVerdict: options.reuseEquivalentVerdict ?? false,
      },
      evidence,
      verdict
    )

    return { verdict, gateVerdictId: record.id }
  })
}

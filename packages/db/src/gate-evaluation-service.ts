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
import { loadVerifiedAssessedScans, MAX_EVIDENCE_BYTES } from "./gate-assessed-scan-evidence"
import { loadGateFindings, prepareGateFindingInputs } from "./gate-retest-input"
import { withWorkspaceRLS, type ScopedTransaction } from "./rls"

export interface GateEvaluationResult {
  verdict: GateVerdictResult
  gateVerdictId: string
  /** Present when the gate could not evaluate at all (e.g. no completed scan). */
  note?: string
}

export async function loadBoundedCandidateManifest(
  tx: ScopedTransaction,
  workspaceId: string,
  targetId: string,
  scanId: string
): Promise<Parameters<typeof snapshotFromManifest>[0]["manifest"]> {
  const rows = await tx.$queryRaw<
    { candidateManifest: Parameters<typeof snapshotFromManifest>[0]["manifest"] }[]
  >`
    SELECT CASE WHEN octet_length(m."checksumInput") <= ${MAX_EVIDENCE_BYTES}
      AND octet_length(m."manifest"::text) <= ${MAX_EVIDENCE_BYTES}
      AND octet_length(m."checksum") = 64 AND m."checksum" ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(m."manifest") = 'object'
      THEN jsonb_build_object('version', m."version", 'checksum', m."checksum", 'manifest', m."manifest")
      ELSE NULL END AS "candidateManifest"
    FROM "ScanResultManifest" m JOIN "Scan" s ON s."id" = m."scanId"
    WHERE s."id" = ${scanId} AND s."workspaceId" = ${workspaceId}
      AND s."targetId" = ${targetId} AND s."deletedAt" IS NULL AND s."status" = 'COMPLETED'
  `
  return rows[0]?.candidateManifest ?? null
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
    const candidateManifest = latestCompletedScan
      ? await loadBoundedCandidateManifest(tx, workspaceId, targetId, latestCompletedScan.id)
      : null
    const candidateSnapshot = latestCompletedScan
      ? snapshotFromManifest({
          scanId: latestCompletedScan.id,
          endedAt: latestCompletedScan.endedAt,
          policyId: latestCompletedScan.policyId,
          policyFingerprint,
          manifest: candidateManifest,
        })
      : null

    const verifiedScan = candidateSnapshot
      ? (
          await loadVerifiedAssessedScans(tx, workspaceId, [
            { targetId, scanId: candidateSnapshot.scanId, assessmentSnapshot: candidateSnapshot },
          ])
        ).verified.get(targetId)
      : undefined
    const assessmentSnapshot = verifiedScan ? candidateSnapshot : null
    const coverageReceipts = verifiedScan?.coverageReceipts ?? []

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
        reason: r.reason ?? null,
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

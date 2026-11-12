/**
 * Launch Gate service — adapts stored workspace evidence into the pure
 * @lyrashield/gate compute and persists the resulting immutable GateVerdict.
 *
 * Boundary rule (same as the score layer): packages/gate owns the versioned
 * verdict math; this service owns all database reads/writes. All reads go
 * through withWorkspaceRLS — never the system client.
 */

import {
  evaluateGateApplicability,
  type GateApplicabilityResult,
  type GateVerdictResult,
} from "@lyrashield/gate"
import { fingerprintPolicy, parseAssessmentSnapshot } from "./gate-assessment"
import { loadVerifiedAssessedScans } from "./gate-assessed-scan-evidence"
import {
  findMismatchedGateEvidence,
  invalidateUntrustedGateEvidence,
  type StoredGateEvidence,
} from "./gate-reader-evidence"
import { withWorkspaceRLS, type ScopedTransaction } from "./rls"
import { loadBoundedGateVerdicts } from "./gate-verdict-read"

export { parseAssessmentSnapshot }
export { evaluateGateForTarget, type GateEvaluationResult } from "./gate-evaluation-service"
export {
  getCurrentGateVerdicts,
  MAX_GATE_READ_BATCH_TARGETS,
  type GateVerdictBatchResult,
} from "./gate-verdict-batch"
export { handleFixPrMergedAndReevaluate, type FixPrMergeOutcome } from "./fix-pr-merge-service"

/**
 * Read the latest verdict for a target without recomputing. Returns null when
 * no verdict has been recorded yet.
 */
export async function getLatestGateVerdict(workspaceId: string, targetId: string) {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const row = (await loadBoundedGateVerdicts(tx, workspaceId, { targetIds: [targetId] }))[0]
    if (!row) return null
    const { evidenceTooLarge, ...historical } = row
    if (evidenceTooLarge) return null
    return historical
  })
}

export interface GateApplicabilityOptions {
  expectedCommit?: string | null
  expectedArtifactDigest?: string | null
  now?: Date
}

/**
 * Evaluate one persisted verdict for applicability inside the caller's
 * transaction. Shared by the single-target current read and launch-report
 * issuance so both answer "is THIS verdict still usable" identically: the
 * reads (policy, newer-attempt, evidence drift) run on `tx`, and the caller
 * owns the observation point via `options.now`.
 *
 * The caller's transaction decides consistency: under the default isolation
 * each statement sees its own committed snapshot; a stronger isolation level
 * (e.g. RepeatableRead) makes the whole evaluation one observation.
 */
export async function evaluateVerdictApplicability(
  tx: ScopedTransaction,
  workspaceId: string,
  verdict: StoredGateEvidence & {
    targetId: string
    evaluatedAt: Date
    assessmentSnapshot: unknown
    scanId: string | null
  },
  options: GateApplicabilityOptions = {}
): Promise<GateApplicabilityResult> {
  const snapshot = parseAssessmentSnapshot(verdict.assessmentSnapshot)
  const policy = snapshot
    ? await tx.policy.findFirst({
        where: { id: snapshot.policyId, workspaceId, deletedAt: null },
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
  const [newerAssessmentAttempt, findingChanged, verificationChanged] = snapshot
    ? await Promise.all([
        tx.scan.findFirst({
          where: {
            workspaceId,
            targetId: verdict.targetId,
            deletedAt: null,
            id: { not: snapshot.scanId },
            OR: [
              { createdAt: { gt: new Date(snapshot.completedAtMs) } },
              { endedAt: { gt: new Date(snapshot.completedAtMs) } },
            ],
          },
          select: { id: true },
        }),
        tx.finding.findFirst({
          where: {
            workspaceId,
            targetId: verdict.targetId,
            deletedAt: null,
            updatedAt: { gt: verdict.evaluatedAt },
          },
          select: { id: true },
        }),
        tx.findingVerification.findFirst({
          where: {
            workspaceId,
            createdAt: { gt: verdict.evaluatedAt },
            finding: { targetId: verdict.targetId, deletedAt: null },
          },
          select: { id: true },
        }),
      ])
    : [null, null, null]
  const result = evaluateGateApplicability(verdict.state as GateVerdictResult["state"], {
    snapshot,
    expectedCommit: options.expectedCommit,
    expectedArtifactDigest: options.expectedArtifactDigest,
    policyFingerprint: fingerprintPolicy(policy as Record<string, unknown> | null),
    nowMs: (options.now ?? new Date()).getTime(),
    newerAssessmentAttempt: Boolean(newerAssessmentAttempt),
    evidenceChanged: Boolean(findingChanged || verificationChanged),
  })
  if (snapshot) {
    const assessed = await loadVerifiedAssessedScans(tx, workspaceId, [verdict])
    if (assessed.unverified.has(verdict.targetId)) return invalidateUntrustedGateEvidence(result)
    if (
      (await findMismatchedGateEvidence(tx, workspaceId, [verdict], assessed.verified)).has(
        verdict.targetId
      )
    ) {
      return invalidateUntrustedGateEvidence(result)
    }
  }
  return result
}

/**
 * Reads immutable verdict history and applies it to the release identity being
 * enforced. A failed current read is deliberately an error, never cached READY.
 */
export async function getCurrentGateVerdict(
  workspaceId: string,
  targetId: string,
  options: GateApplicabilityOptions = {}
) {
  const read = async (tx: ScopedTransaction) => {
    const row = (await loadBoundedGateVerdicts(tx, workspaceId, { targetIds: [targetId] }))[0]
    if (!row) return null
    const { evidenceTooLarge, ...historical } = row

    const checked = await evaluateVerdictApplicability(tx, workspaceId, historical, options)
    const applicability = evidenceTooLarge ? invalidateUntrustedGateEvidence(checked) : checked

    return {
      schemaVersion: "lyrashield-gate-response/2.0.0",
      state: applicability.effectiveState,
      applicability: {
        applicable: applicability.applicable,
        reasons: applicability.reasons,
        // The identity this read was evaluated against: the enforced release
        // identity when the caller supplied one, otherwise the assessment's
        // own identity (read-only surfaces label the verdict with it).
        evaluatedIdentity: applicability.evaluatedIdentity,
      },
      historical,
    }
  }
  return withWorkspaceRLS(workspaceId, read, { isolationLevel: "RepeatableRead" })
}

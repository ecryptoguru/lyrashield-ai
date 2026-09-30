import {
  evaluateGateApplicability,
  type GateAssessmentSnapshot,
  type GateVerdictResult,
} from "@lyrashield/gate"
import { fingerprintPolicy, parseAssessmentSnapshot } from "./gate-assessment"
import type { GateApplicabilityOptions } from "./gate-service"
import { withWorkspaceRLS } from "./rls"

/**
 * Batched form of getCurrentGateVerdict for read surfaces that evaluate every
 * active target at once (Home, Launch Readiness). One transaction with a
 * statement count constant in the number of targets replaces N transactions of
 * ~6 statements each — the per-target fan-out was the Deep Review v16 2.1 P1.
 *
 * Same applicability semantics, same fail-closed reasons, same result shape per
 * target; the map omits targets with no verdict (callers render
 * NO_GATE_VERDICT for those, exactly as the single-target null does).
 */
export async function getCurrentGateVerdicts(
  workspaceId: string,
  targetIds: string[],
  options: GateApplicabilityOptions = {}
): Promise<Map<string, GateVerdictBatchResult>> {
  const results = new Map<string, GateVerdictBatchResult>()
  if (targetIds.length === 0) return results

  const nowMs = (options.now ?? new Date()).getTime()

  await withWorkspaceRLS(workspaceId, async (tx) => {
    // 1) Latest verdict per target — DISTINCT ON over the existing
    // (workspaceId, targetId, evaluatedAt) index. RLS applies: this runs
    // inside the transaction after SET LOCAL app.current_workspace_id.
    // GateVerdict has no deletedAt column (not in SOFT_DELETE_MODELS), so no
    // soft-delete predicate is due here — same as the per-target read. The
    // array binds with = ANY(...): `IN (${array})` binds a text[] parameter
    // against a text column and fails with P2010 text = text[].
    const verdicts = await tx.$queryRaw<GateVerdictRawRow[]>`
      SELECT * FROM (
        SELECT DISTINCT ON ("targetId") *
        FROM "GateVerdict"
        WHERE "workspaceId" = ${workspaceId}
          AND "targetId" = ANY(${targetIds}::text[])
        ORDER BY "targetId", "evaluatedAt" DESC, "id" DESC
      ) latest
      ORDER BY "targetId"`

    if (verdicts.length === 0) return

    // 2) Policies referenced by the parsed snapshots — one indexed IN read.
    const snapshotByTarget = new Map<string, GateAssessmentSnapshot | null>()
    for (const verdict of verdicts) {
      snapshotByTarget.set(verdict.targetId, parseAssessmentSnapshot(verdict.assessmentSnapshot))
    }
    const policyIds = [
      ...new Set(
        verdicts
          .map((verdict) => snapshotByTarget.get(verdict.targetId)?.policyId)
          .filter((id): id is string => Boolean(id))
      ),
    ]
    const policies = policyIds.length
      ? await tx.policy.findMany({
          where: { id: { in: policyIds }, workspaceId, deletedAt: null },
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
      : []
    const policyById = new Map(policies.map((policy) => [policy.id, policy]))

    // 3) The three evidence-drift existence checks, set-wide. Each verdict's
    // thresholds differ, so the per-target parameters travel as an unnest row
    // set joined against the table — one statement per check, not per target.
    // Scan and Finding carry deletedAt and the predicate is explicit (raw SQL
    // bypasses the Prisma extension's soft-delete injection); GateVerdict and
    // FindingVerification have no deletedAt column, matching the per-target
    // read's filters exactly.
    const rowsWithSnapshot = verdicts.filter(
      (verdict) => snapshotByTarget.get(verdict.targetId) !== null
    )
    let newerAttemptTargets: Set<string> = new Set()
    let findingChangedTargets: Set<string> = new Set()
    let verificationChangedTargets: Set<string> = new Set()
    if (rowsWithSnapshot.length > 0) {
      const [newerRows, findingRows, verificationRows] = await Promise.all([
        tx.$queryRaw<Array<{ targetId: string }>>`
          SELECT v."targetId"
          FROM unnest(
            ${rowsWithSnapshot.map((v) => v.targetId)}::text[],
            ${rowsWithSnapshot.map((v) => snapshotByTarget.get(v.targetId)?.scanId ?? "")}::text[],
            ${rowsWithSnapshot.map(
              (v) => new Date(snapshotByTarget.get(v.targetId)?.completedAtMs ?? 0)
            )}::timestamptz[]
          ) AS v("targetId", "scanId", "completedAt")
          JOIN "Scan" s
            ON s."workspaceId" = ${workspaceId}
           AND s."targetId" = v."targetId"
           AND s."deletedAt" IS NULL
           AND s."id" <> v."scanId"
           AND s."createdAt" > v."completedAt"
          GROUP BY v."targetId"`,
        tx.$queryRaw<Array<{ targetId: string }>>`
          SELECT v."targetId"
          FROM unnest(
            ${rowsWithSnapshot.map((v) => v.targetId)}::text[],
            ${rowsWithSnapshot.map((v) => v.evaluatedAt)}::timestamptz[]
          ) AS v("targetId", "evaluatedAt")
          JOIN "Finding" f
            ON f."workspaceId" = ${workspaceId}
           AND f."targetId" = v."targetId"
           AND f."deletedAt" IS NULL
           AND f."updatedAt" > v."evaluatedAt"
          GROUP BY v."targetId"`,
        tx.$queryRaw<Array<{ targetId: string }>>`
          SELECT v."targetId"
          FROM unnest(
            ${rowsWithSnapshot.map((v) => v.targetId)}::text[],
            ${rowsWithSnapshot.map((v) => v.evaluatedAt)}::timestamptz[]
          ) AS v("targetId", "evaluatedAt")
          JOIN "FindingVerification" fv
            ON fv."workspaceId" = ${workspaceId}
           AND fv."createdAt" > v."evaluatedAt"
          JOIN "Finding" f
            ON f."id" = fv."findingId"
           AND f."targetId" = v."targetId"
           AND f."deletedAt" IS NULL
          GROUP BY v."targetId"`,
      ])
      newerAttemptTargets = new Set(newerRows.map((row) => row.targetId))
      findingChangedTargets = new Set(findingRows.map((row) => row.targetId))
      verificationChangedTargets = new Set(verificationRows.map((row) => row.targetId))
    }

    // 4) Apply the same applicability rules per target, in memory. The raw
    // row is MAPPED explicitly into the historical payload — never asserted
    // to be the Prisma model type (raw queries return JSON as parsed objects
    // and timestamps as Date, which this mapping preserves).
    for (const row of verdicts) {
      const snapshot = snapshotByTarget.get(row.targetId) ?? null
      const policy = snapshot ? (policyById.get(snapshot.policyId) ?? null) : null
      const applicability = evaluateGateApplicability(row.state as GateVerdictResult["state"], {
        snapshot,
        expectedCommit: options.expectedCommit,
        expectedArtifactDigest: options.expectedArtifactDigest,
        policyFingerprint: fingerprintPolicy(policy as Record<string, unknown> | null),
        nowMs,
        newerAssessmentAttempt: newerAttemptTargets.has(row.targetId),
        evidenceChanged:
          findingChangedTargets.has(row.targetId) || verificationChangedTargets.has(row.targetId),
      })
      results.set(row.targetId, {
        schemaVersion: "lyrashield-gate-response/2.0.0",
        state: applicability.effectiveState,
        applicability: {
          applicable: applicability.applicable,
          reasons: applicability.reasons,
          // Same contract as the single-target read: the enforced identity
          // when supplied, otherwise the assessment's own.
          evaluatedIdentity: applicability.evaluatedIdentity,
        },
        historical: {
          id: row.id,
          workspaceId: row.workspaceId,
          targetId: row.targetId,
          scanId: row.scanId,
          standardVersion: row.standardVersion,
          state: row.state,
          coverageStatement: row.coverageStatement,
          nonCoverage: row.nonCoverage,
          blockingReasons: row.blockingReasons,
          evidenceSummary: row.evidenceSummary,
          staleness: row.staleness,
          inputChecksum: row.inputChecksum,
          verdictChecksum: row.verdictChecksum,
          assessmentVersion: row.assessmentVersion,
          assessmentSnapshot: row.assessmentSnapshot,
          evaluatedAt: row.evaluatedAt,
        },
      })
    }
  })

  return results
}

/**
 * Result of a batched current-verdict read. Same per-target shape as the
 * single-target read; `historical` is the explicitly-mapped GateVerdict
 * payload (a raw row mapped field by field, not the Prisma model instance).
 */
export interface GateVerdictBatchResult {
  schemaVersion: "lyrashield-gate-response/2.0.0"
  state: "READY" | "NOT_READY" | "INSUFFICIENT_EVIDENCE"
  applicability: {
    applicable: boolean
    reasons: { code: string; message: string }[]
    evaluatedIdentity: { kind: "COMMIT" | "ARTIFACT_DIGEST"; value: string } | null
  }
  historical: {
    id: string
    workspaceId: string
    targetId: string
    scanId: string | null
    standardVersion: string
    state: string
    coverageStatement: unknown
    nonCoverage: unknown
    blockingReasons: unknown
    evidenceSummary: unknown
    staleness: unknown
    inputChecksum: string
    verdictChecksum: string
    assessmentVersion: number | null
    assessmentSnapshot: unknown
    evaluatedAt: Date
  }
}

/**
 * Raw GateVerdict row from the DISTINCT ON read: camelCase quoted columns,
 * JSON columns arrive as parsed objects, timestamps as Date. This is the
 * $queryRaw wire shape — deliberately NOT the Prisma model type.
 */
type GateVerdictRawRow = {
  id: string
  workspaceId: string
  targetId: string
  scanId: string | null
  standardVersion: string
  state: string
  coverageStatement: unknown
  nonCoverage: unknown
  blockingReasons: unknown
  evidenceSummary: unknown
  staleness: unknown
  inputChecksum: string
  verdictChecksum: string
  assessmentVersion: number | null
  assessmentSnapshot: unknown
  evaluatedAt: Date
}

/**
 * Launch Gate service — adapts stored workspace evidence into the pure
 * @lyrashield/gate compute and persists the resulting immutable GateVerdict.
 *
 * Boundary rule (same as the score layer): packages/gate owns the versioned
 * verdict math; this service owns all database reads/writes. All reads go
 * through withWorkspaceRLS — never the system client.
 */

import {
  computeGateVerdict,
  computeInputChecksum,
  computeVerdictChecksum,
  evaluateGateApplicability,
  requiredScannersForTarget,
  isTargetTypeCovered,
  type GateApplicabilityResult,
  type GateAssessmentSnapshot,
  type GateEvidenceInput,
  type GateVerdictResult,
} from "@lyrashield/gate"
import { logger } from "@lyrashield/logger"
import {
  resolveRetestProfile,
  resolveTargetScanMode,
  type ScanGoal,
  type ScanMode,
} from "@lyrashield/types"
import type { FixPrMergeResult } from "./fix-proposal-service"
import {
  fingerprintPolicy,
  isTrustedRetestReceipt,
  parseAssessmentSnapshot,
  snapshotFromManifest,
  toEpochMs,
} from "./gate-assessment"
import { bindAccountRLSContext, withWorkspaceRLS, type ScopedTransaction } from "./rls"

export { parseAssessmentSnapshot }

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

/**
 * Read the latest verdict for a target without recomputing. Returns null when
 * no verdict has been recorded yet.
 */
export async function getLatestGateVerdict(workspaceId: string, targetId: string) {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    return tx.gateVerdict.findFirst({
      where: { workspaceId, targetId },
      // id tiebreaker: evaluatedAt is a timestamp — two verdicts in the same
      // millisecond are possible (e.g. merge + completion in one tick), and
      // ordering by timestamp alone would make the "latest" nondeterministic.
      orderBy: [{ evaluatedAt: "desc" }, { id: "desc" }],
    })
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
  verdict: {
    targetId: string
    state: string
    evaluatedAt: Date
    assessmentSnapshot: unknown
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
            createdAt: { gt: new Date(snapshot.completedAtMs) },
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
  return evaluateGateApplicability(verdict.state as GateVerdictResult["state"], {
    snapshot,
    expectedCommit: options.expectedCommit,
    expectedArtifactDigest: options.expectedArtifactDigest,
    policyFingerprint: fingerprintPolicy(policy as Record<string, unknown> | null),
    nowMs: (options.now ?? new Date()).getTime(),
    newerAssessmentAttempt: Boolean(newerAssessmentAttempt),
    evidenceChanged: Boolean(findingChanged || verificationChanged),
  })
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
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const historical = await tx.gateVerdict.findFirst({
      where: { workspaceId, targetId },
      orderBy: [{ evaluatedAt: "desc" }, { id: "desc" }],
    })
    if (!historical) return null

    const applicability = await evaluateVerdictApplicability(tx, workspaceId, historical, options)

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
  })
}

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
            ${verdicts.map((v) => v.targetId)}::text[],
            ${verdicts.map((v) => v.evaluatedAt)}::timestamptz[]
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
            ${verdicts.map((v) => v.targetId)}::text[],
            ${verdicts.map((v) => v.evaluatedAt)}::timestamptz[]
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

/**
 * WP3 loop-closure orchestration: mark a merged fix PR, then queue a REAL
 * retest — a new scan of the finding's target that the retest binds to — and
 * re-evaluate the gate after that retest completes.
 *
 * The retest anchoring matters: `completeRetestsForScan` matches
 * `Retest.scanId` against the scan being completed, so a Retest stamped with
 * the finding's ORIGINAL (terminal) scan would never complete — it would sit
 * pending forever. This function therefore resolves the latest completed
 * scan, creates a fresh retest scan from it, and binds the Retest to the NEW
 * scan. The caller (the GitHub webhook route) enqueues the new scan —
 * packages/db cannot import the queue package without a dependency cycle.
 *
 * Returns null (a no-op) when the branch matches no open or merged fix PR in this
 * workspace.
 */
export async function handleFixPrMergedAndReevaluate(
  workspaceId: string,
  branchName: string,
  prNumber: number | undefined,
  assertRetestAllowed: (
    mode: ScanMode,
    sponsorAccountId: string,
    tx: ScopedTransaction
  ) => Promise<void>,
  repoFullName?: string
): Promise<FixPrMergeOutcome | null> {
  if (typeof assertRetestAllowed !== "function") throw new Error("Retest admission guard required")
  const [repoOwner, repoName, ...extra] = repoFullName?.split("/") ?? []
  if (repoFullName && (!repoOwner || !repoName || extra.length > 0)) {
    throw new Error("Invalid GitHub repository identity")
  }
  const advisoryKey = `fix-loop:${workspaceId}:${branchName}`
  const findAnchor = async (tx: ScopedTransaction) => {
    const pr = await tx.pullRequest.findFirst({
      where: {
        branchName,
        ...(repoOwner && repoName ? { repoOwner, repoName } : {}),
        ...(prNumber ? { OR: [{ prNumber }, { prNumber: null }] } : {}),
        status: { in: ["open", "merged"] },
        deletedAt: null,
        fixProposal: { finding: { workspaceId, deletedAt: null } },
      },
      select: {
        fixProposal: {
          select: {
            finding: {
              select: {
                id: true,
                targetId: true,
                scan: {
                  select: { id: true, goal: true, mode: true, policyId: true, targetId: true },
                },
              },
            },
          },
        },
      },
    })
    const finding = pr?.fixProposal?.finding
    if (!finding?.targetId || !finding.scan) return null

    const latestCompleted = await tx.scan.findFirst({
      where: { workspaceId, targetId: finding.targetId, status: "COMPLETED", deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, goal: true, mode: true, policyId: true, targetId: true },
    })
    const template = latestCompleted ?? finding.scan
    if (!template.targetId) return null
    const retestTemplate: {
      id: string
      goal: ScanGoal
      mode: ScanMode
      policyId: string | null
      targetId: string
    } = { ...template, targetId: template.targetId }
    return {
      findingId: finding.id,
      sourceScanId: finding.scan.id,
      sourceMode: finding.scan.mode,
      targetId: template.targetId,
      template: retestTemplate,
    }
  }

  const { handleFixPrMerged } = await import("./fix-proposal-service")
  // This helper commits merge state separately so failed retest creation can
  // resume on redelivery. It takes the same advisory lock in its transaction.
  const result = await handleFixPrMerged({ workspaceId, branchName, prNumber, repoFullName })
  if (!result) return null

  const outcome = await withWorkspaceRLS(
    workspaceId,
    async (lockTx) => {
      // Serialize redeliveries through scan creation and durable retest association.
      await lockTx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${advisoryKey}, 0))`
      const anchor = await findAnchor(lockTx)
      if (!anchor) return null

      // The retest's sponsoring account is the recorded actor — bind the
      // account RLS context inside this transaction so the entitlement check
      // sees the sponsor's ledger rows across workspaces.
      await bindAccountRLSContext(lockTx, result.actedById)

      const marker = `Automatic fix PR retest: ${result.pullRequestId}`
      const prior = await lockTx.retest.findFirst({
        where: { workspaceId, findingId: anchor.findingId, resultBefore: marker },
        include: { scan: true },
        orderBy: { createdAt: "desc" },
      })
      if (prior) {
        // A queue failure leaves the same durable scan available for redelivery.
        if (prior.scan.status !== "QUEUED") return null
        await assertRetestAllowed(prior.scan.mode, result.actedById, lockTx)
        return {
          ...result,
          retestId: prior.id,
          retestScanId: prior.scanId,
          targetId: anchor.targetId,
          goal: prior.scan.goal,
          mode: prior.scan.mode,
          policyId: prior.scan.policyId,
        }
      }
      const pending = await lockTx.retest.findFirst({
        where: { workspaceId, findingId: anchor.findingId, status: { in: ["pending", "running"] } },
      })
      if (pending) return null
      const target = await lockTx.target.findFirst({
        where: { workspaceId, id: anchor.targetId, deletedAt: null },
        select: { type: true, apiSpecUrl: true },
      })
      if (!target) return null
      const candidates = await lockTx.findingCandidate.findMany({
        where: { workspaceId, findingId: anchor.findingId, scanId: anchor.sourceScanId },
        select: { scannerSource: true },
      })
      const profile = resolveRetestProfile(
        anchor.sourceMode,
        candidates.map((c) => c.scannerSource)
      )
      const resolved = resolveTargetScanMode({
        targetType: target.type,
        mode: profile.mode as ScanMode,
        hasApiSpec: Boolean(target.apiSpecUrl),
      })
      if (!resolved.ok) throw new Error(resolved.reason)
      await assertRetestAllowed(profile.mode as ScanMode, result.actedById, lockTx)

      // Create the REAL retest scan + Retest row bound to it. This mirrors the
      // user retest route (api/findings/[id]/retests): createScan with
      // triggerType "retest", Retest.scanId = the NEW scan id. The Retest stays
      // pending until the new scan completes, when completeRetestsForScan binds
      // its verdict to the stored baseline/retest checksums.
      const { createScan, WorkspaceScanConcurrencyLimitError } = await import("./scan-service")
      let retestScanId: string | undefined
      let retestId: string
      try {
        const retestScan = await createScan(
          {
            workspaceId,
            targetId: anchor.template.targetId,
            goal: anchor.template.goal,
            mode: profile.mode as ScanMode,
            determinismMode: profile.determinismMode,
            policyId: anchor.template.policyId ?? undefined,
            createdById: result.actedById,
            triggerType: "retest",
          },
          lockTx
        )
        retestScanId = retestScan.id
        const retest = await lockTx.retest.create({
          data: {
            workspaceId,
            findingId: anchor.findingId,
            scanId: retestScanId,
            status: "pending",
            resultBefore: marker,
          },
        })
        retestId = retest.id
      } catch (retestError) {
        if (
          retestError instanceof WorkspaceScanConcurrencyLimitError ||
          (retestError instanceof Error &&
            retestError.message === "Target already has an active scan")
        ) {
          logger.info("Automatic retest deferred until scan capacity is available", {
            workspaceId,
            branchName,
          })
          throw retestError
        }
        // Scan and Retest share the transaction: any failure rolls both back.
        // Redelivery can resume from the separately persisted merge state.
        logger.error("Failed to create loop-closure retest scan", {
          workspaceId,
          branchName,
          error: retestError instanceof Error ? retestError.message : String(retestError),
        })
        throw retestError
      }

      return {
        ...result,
        retestId,
        retestScanId,
        targetId: anchor.template.targetId,
        goal: anchor.template.goal,
        mode: profile.mode as ScanMode,
        policyId: anchor.template.policyId,
      }
    },
    { timeout: 30_000 }
  )
  // Gate evaluation cannot hold open or roll back the scan/association commit.
  if (outcome)
    await evaluateGateForTarget(workspaceId, outcome.targetId).catch((error) => {
      logger.warn("Gate re-evaluation after fix PR merge failed (non-fatal)", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  return outcome
}

/** handleFixPrMergedAndReevaluate result: the merge outcome plus the retest scan to enqueue. */
export interface FixPrMergeOutcome extends FixPrMergeResult {
  /** The newly created retest scan the CALLER must enqueue. */
  retestScanId: string
  /** The template the retest scan was created from — the fields the caller's enqueue payload needs. */
  targetId: string
  /** Scan goal/mode as the canonical union names so the webhook enqueue
   * payload satisfies ScanJobData directly. */
  goal: ScanGoal
  mode: ScanMode
  policyId: string | null
}

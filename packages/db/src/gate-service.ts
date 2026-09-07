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
  GATE_ASSESSMENT_VERSION,
  evaluateGateApplicability,
  requiredScannersForTarget,
  isTargetTypeCovered,
  type GateAssessmentSnapshot,
  type GateEvidenceInput,
  type GateVerdictResult,
} from "@lyrashield/gate"
import { createHash } from "node:crypto"
import { logger } from "@lyrashield/logger"
import {
  resolveRetestProfile,
  resolveTargetScanMode,
  type ScanGoal,
  type ScanMode,
} from "@lyrashield/types"
import type { FixPrMergeResult } from "./fix-proposal-service"
import { withWorkspaceRLS } from "./rls"

export interface GateEvaluationResult {
  verdict: GateVerdictResult
  gateVerdictId: string
  /** Present when the gate could not evaluate at all (e.g. no completed scan). */
  note?: string
}

function toEpochMs(value: Date | null | undefined): number | null {
  return value ? value.getTime() : null
}

const SUPPORTED_MANIFEST_VERSION = 7
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i
const ARTIFACT_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    )
  }
  return value
}

function fingerprintPolicy(policy: Record<string, unknown> | null): string | null {
  if (!policy) return null
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(policy)))
    .digest("hex")
}

function snapshotFromManifest(input: {
  scanId: string
  endedAt: Date | null
  policyId: string | null
  policyFingerprint: string | null
  manifest: { version: number; checksum: string; manifest: unknown } | null
}): GateAssessmentSnapshot | null {
  const manifest = input.manifest
  if (
    !manifest ||
    manifest.version !== SUPPORTED_MANIFEST_VERSION ||
    !input.endedAt ||
    !input.policyId ||
    !input.policyFingerprint
  ) {
    return null
  }
  const raw = manifest.manifest as {
    engineExecution?: { sourceRevision?: unknown } | null
    sourceExecution?: { sourceRevision?: unknown } | null
    target?: { artifactDigest?: unknown } | null
  }
  const revision = raw.sourceExecution?.sourceRevision ?? raw.engineExecution?.sourceRevision
  const artifactDigest = raw.target?.artifactDigest
  const identity =
    typeof revision === "string" && COMMIT_PATTERN.test(revision)
      ? { kind: "COMMIT" as const, value: revision }
      : typeof artifactDigest === "string" && ARTIFACT_DIGEST_PATTERN.test(artifactDigest)
        ? { kind: "ARTIFACT_DIGEST" as const, value: artifactDigest }
        : null
  if (!identity) return null
  return {
    version: GATE_ASSESSMENT_VERSION,
    scanId: input.scanId,
    completedAtMs: input.endedAt.getTime(),
    manifestChecksum: manifest.checksum,
    manifestVersion: manifest.version,
    policyId: input.policyId,
    policyFingerprint: input.policyFingerprint,
    identity,
  }
}

function isTrustedRetestReceipt(
  receipt: {
    status: string
    method: string
    scanId: string
    verifierVersion: string | null
    evidence: unknown
  },
  sourceScanId: string
): boolean {
  if (
    receipt.status !== "VALIDATED" ||
    receipt.method !== "RETEST" ||
    !receipt.verifierVersion?.startsWith("result-integrity-")
  ) {
    return false
  }
  const evidence = receipt.evidence as {
    baseline?: { scanId?: unknown } | null
    retest?: { scanId?: unknown } | null
  } | null
  return evidence?.baseline?.scanId === sourceScanId && evidence.retest?.scanId === receipt.scanId
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
        ? requiredScannersForTarget(target.type)
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

function parseAssessmentSnapshot(value: unknown): GateAssessmentSnapshot | null {
  if (!value || typeof value !== "object") return null
  const snapshot = value as Partial<GateAssessmentSnapshot>
  if (
    snapshot.version !== GATE_ASSESSMENT_VERSION ||
    typeof snapshot.scanId !== "string" ||
    typeof snapshot.completedAtMs !== "number" ||
    typeof snapshot.manifestChecksum !== "string" ||
    snapshot.manifestVersion !== SUPPORTED_MANIFEST_VERSION ||
    typeof snapshot.policyId !== "string" ||
    typeof snapshot.policyFingerprint !== "string" ||
    !snapshot.identity ||
    (snapshot.identity.kind !== "COMMIT" && snapshot.identity.kind !== "ARTIFACT_DIGEST") ||
    typeof snapshot.identity.value !== "string"
  ) {
    return null
  }
  return snapshot as GateAssessmentSnapshot
}

export interface GateApplicabilityOptions {
  expectedCommit?: string | null
  expectedArtifactDigest?: string | null
  now?: Date
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

    const snapshot = parseAssessmentSnapshot(historical.assessmentSnapshot)
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
              targetId,
              deletedAt: null,
              id: { not: snapshot.scanId },
              createdAt: { gt: new Date(snapshot.completedAtMs) },
            },
            select: { id: true },
          }),
          tx.finding.findFirst({
            where: {
              workspaceId,
              targetId,
              deletedAt: null,
              updatedAt: { gt: historical.evaluatedAt },
            },
            select: { id: true },
          }),
          tx.findingVerification.findFirst({
            where: {
              workspaceId,
              createdAt: { gt: historical.evaluatedAt },
              finding: { targetId, deletedAt: null },
            },
            select: { id: true },
          }),
        ])
      : [null, null, null]
    const applicability = evaluateGateApplicability(
      historical.state as GateVerdictResult["state"],
      {
        snapshot,
        expectedCommit: options.expectedCommit,
        expectedArtifactDigest: options.expectedArtifactDigest,
        policyFingerprint: fingerprintPolicy(policy as Record<string, unknown> | null),
        nowMs: (options.now ?? new Date()).getTime(),
        newerAssessmentAttempt: Boolean(newerAssessmentAttempt),
        evidenceChanged: Boolean(findingChanged || verificationChanged),
      }
    )

    return {
      schemaVersion: "lyrashield-gate-response/2.0.0",
      state: applicability.effectiveState,
      applicability: {
        applicable: applicability.applicable,
        reasons: applicability.reasons,
      },
      historical,
    }
  })
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
  assertRetestAllowed: (mode: ScanMode) => Promise<void>
): Promise<FixPrMergeOutcome | null> {
  if (typeof assertRetestAllowed !== "function") throw new Error("Retest admission guard required")
  const outcome = await withWorkspaceRLS(
    workspaceId,
    async (lockTx) => {
      // Serialize redeliveries through scan creation and durable retest association.
      await lockTx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fix-loop:${workspaceId}:${branchName}`}, 0))`
      const { handleFixPrMerged } = await import("./fix-proposal-service")

      // Resolve the finding's target and its latest COMPLETED scan (the retest
      // template) — both under RLS.
      const anchor = await withWorkspaceRLS(workspaceId, async (tx) => {
        const pr = await tx.pullRequest.findFirst({
          where: {
            branchName,
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

        // The latest COMPLETED scan for the target is the retest template — the
        // source scan whose evidence the retest compares against. Fall back to the
        // finding's own source scan when no completed scan exists.
        const latestCompleted = await tx.scan.findFirst({
          where: { workspaceId, targetId: finding.targetId, status: "COMPLETED", deletedAt: null },
          orderBy: { createdAt: "desc" },
          select: { id: true, goal: true, mode: true, policyId: true, targetId: true },
        })
        const template = latestCompleted ?? finding.scan
        // Scan.targetId is nullable in the schema; a scan row without a target
        // cannot anchor a retest. (Finding.targetId is already null-checked above.)
        if (!template.targetId) return null
        return {
          findingId: finding.id,
          sourceScanId: finding.scan.id,
          sourceMode: finding.scan.mode,
          targetId: template.targetId,
          // Prisma returns the enum values as strings; the asserted type carries
          // the canonical union names so consumers satisfy ScanJobData directly.
          template: {
            ...template,
            targetId: template.targetId,
          } as {
            id: string
            goal: ScanGoal
            mode: ScanMode
            policyId: string | null
            targetId: string
          },
        }
      })
      if (!anchor) return null

      // Persist merge state first. The merge helper also resolves already-merged
      // rows so a retry can resume the missing retest or queue delivery.
      const result = await handleFixPrMerged({
        workspaceId,
        branchName,
        prNumber,
      })
      if (!result) return null

      const marker = `Automatic fix PR retest: ${result.pullRequestId}`
      const prior = await lockTx.retest.findFirst({
        where: { workspaceId, findingId: anchor.findingId, resultBefore: marker },
        include: { scan: true },
        orderBy: { createdAt: "desc" },
      })
      if (prior) {
        // A queue failure leaves the same durable scan available for redelivery.
        if (prior.scan.status !== "QUEUED") return null
        await assertRetestAllowed(prior.scan.mode)
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
      await assertRetestAllowed(profile.mode as ScanMode)

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

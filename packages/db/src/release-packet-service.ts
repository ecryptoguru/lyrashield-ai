import { createHash } from "node:crypto"
import {
  computeReleasePacketChecksum,
  RELEASE_PACKET_VERSION,
  ReleasePacketPayloadSchema,
  type ReleasePacketFinding,
  type ReleasePacketPayload,
  type SignedAssessment,
} from "@lyrashield/types"
import { withWorkspaceRLS, type ScopedTransaction } from "./rls"
import { evaluateVerdictApplicability, parseAssessmentSnapshot } from "./gate-service"
import { isLaunchReportShareablePayload } from "./launch-report-html"
import { parseLaunchReportProvenance } from "./launch-report-provenance"
import { verifyLaunchReportSignature } from "./launch-report-signing"
import { resolveReportDelegationTarget } from "./report-service"
import { classifyReleaseFindings } from "./release-packet-classification"
import { loadReceiptBackedRetestFindingIds } from "./retest-evidence-trust"

export { classifyReleaseFindings } from "./release-packet-classification"

export class ReleasePacketError extends Error {
  constructor(
    readonly code:
      | "TARGET_NOT_FOUND"
      | "NOT_EVALUATED"
      | "ASSESSMENT_INCOMPLETE"
      | "RELEASE_IDENTITY_MISMATCH"
      | "SNAPSHOT_INVALID",
    message: string
  ) {
    super(message)
    this.name = "ReleasePacketError"
  }
}

function sameIdentity(
  left: { kind: string; value: string } | null,
  right: { kind: string; value: string } | null
): boolean {
  return Boolean(
    left &&
    right &&
    left.kind === right.kind &&
    left.value.toLowerCase() === right.value.toLowerCase()
  )
}

async function signedAssessmentFor(
  tx: ScopedTransaction,
  input: {
    workspaceId: string
    verdictId: string
    identity: { kind: "COMMIT" | "ARTIFACT_DIGEST"; value: string } | null
    publicKey: string | null
    now: Date
  }
): Promise<SignedAssessment> {
  const reports = await tx.report.findMany({
    where: {
      workspaceId: input.workspaceId,
      type: "launch_readiness",
      deletedAt: null,
      provenanceJson: { path: ["gateVerdictId"], equals: input.verdictId },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, contentJson: true, provenanceJson: true },
  })
  const report = reports.find((candidate) => {
    const provenance = parseLaunchReportProvenance(candidate.provenanceJson)
    return (
      provenance?.gateVerdictId === input.verdictId &&
      sameIdentity(provenance.assessedIdentity, input.identity)
    )
  })
  if (!report) {
    return { state: "UNAVAILABLE", reason: "No signed assessment report is bound to this verdict." }
  }
  if (!isLaunchReportShareablePayload(report.contentJson)) {
    return {
      state: "UNAVAILABLE",
      reportId: report.id,
      reason: "The bound assessment report snapshot is unreadable.",
    }
  }
  const payload = report.contentJson
  const common = {
    reportId: report.id,
    reportChecksum: payload.reportChecksum,
    signature: payload.signature,
    signingKeyId: payload.signingKeyId,
    verifiedAt: input.now.toISOString(),
  }
  const expiresAt = payload.expiresAt ? new Date(payload.expiresAt).getTime() : Number.NaN
  if (payload.stale || !Number.isFinite(expiresAt) || expiresAt <= input.now.getTime()) {
    return { ...common, state: "HISTORICAL", reason: "The signed assessment is historical." }
  }
  if (!payload.signature) {
    return {
      ...common,
      state: "UNSIGNED",
      reason: "The assessment was issued without a signature.",
    }
  }
  if (!input.publicKey) {
    return { ...common, state: "UNAVAILABLE", reason: "The verification key is unavailable." }
  }
  return verifyLaunchReportSignature(payload.reportChecksum, payload.signature, input.publicKey)
    ? { ...common, state: "SIGNED" }
    : { state: "INVALID", ...common, reason: "The bound assessment signature is invalid." }
}

export interface IssueReleasePacketInput {
  workspaceId: string
  targetId: string
  actorUserId: string
  expectedIdentity: { kind: "COMMIT" | "ARTIFACT_DIGEST"; value: string }
  signingPublicKey?: string | null
  now?: Date
  detailLimit?: number
}

async function loadAssessedPacketContext(
  tx: ScopedTransaction,
  input: IssueReleasePacketInput,
  now: Date
) {
  const target = await tx.target.findFirst({
    where: { id: input.targetId, workspaceId: input.workspaceId, deletedAt: null },
    select: { id: true, name: true, type: true, environment: true },
  })
  if (!target) throw new ReleasePacketError("TARGET_NOT_FOUND", "Target not found")

  const verdict = await tx.gateVerdict.findFirst({
    where: { workspaceId: input.workspaceId, targetId: input.targetId },
    orderBy: [{ evaluatedAt: "desc" }, { id: "desc" }],
  })
  if (!verdict) {
    throw new ReleasePacketError("NOT_EVALUATED", "No launch assessment exists for this target")
  }
  const snapshot = parseAssessmentSnapshot(verdict.assessmentSnapshot)
  if (!snapshot?.identity) {
    throw new ReleasePacketError(
      "ASSESSMENT_INCOMPLETE",
      "The assessment lacks a supported release identity"
    )
  }
  if (
    snapshot.identity.kind !== input.expectedIdentity.kind ||
    snapshot.identity.value.toLowerCase() !== input.expectedIdentity.value.toLowerCase()
  ) {
    throw new ReleasePacketError(
      "RELEASE_IDENTITY_MISMATCH",
      "The requested release does not match the assessed release"
    )
  }
  const applicability = await evaluateVerdictApplicability(tx, input.workspaceId, verdict, {
    expectedCommit:
      input.expectedIdentity.kind === "COMMIT" ? input.expectedIdentity.value : undefined,
    expectedArtifactDigest:
      input.expectedIdentity.kind === "ARTIFACT_DIGEST" ? input.expectedIdentity.value : undefined,
    now,
  })

  const currentScan = await tx.scan.findFirst({
    where: { id: snapshot.scanId, workspaceId: input.workspaceId, deletedAt: null },
    include: { resultManifest: { select: { checksum: true } } },
  })
  if (!currentScan) {
    throw new ReleasePacketError(
      "ASSESSMENT_INCOMPLETE",
      "The assessed scan is no longer available"
    )
  }
  const baselineScan = await tx.scan.findFirst({
    where: {
      workspaceId: input.workspaceId,
      targetId: input.targetId,
      deletedAt: null,
      id: { not: currentScan.id },
      status: { in: ["COMPLETED", "PARTIAL"] },
      OR: [{ endedAt: { lt: currentScan.endedAt ?? currentScan.createdAt } }, { endedAt: null }],
    },
    orderBy: [{ endedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  })

  return { target, verdict, snapshot, applicability, currentScan, baselineScan }
}

type AssessedPacketContext = Awaited<ReturnType<typeof loadAssessedPacketContext>>

async function loadPacketRemediation(
  tx: ScopedTransaction,
  input: IssueReleasePacketInput,
  context: AssessedPacketContext
) {
  const { currentScan, baselineScan, snapshot } = context

  const [
    findings,
    currentCandidates,
    baselineCandidates,
    uncertainCandidateCount,
    reportsCoverage,
  ] = await Promise.all([
    tx.finding.findMany({
      where: { workspaceId: input.workspaceId, targetId: input.targetId, deletedAt: null },
      select: {
        id: true,
        scanId: true,
        dedupeKey: true,
        title: true,
        severity: true,
        status: true,
        verificationStatus: true,
        baseCommit: true,
        firstSeenAt: true,
        lastSeenAt: true,
        verificationReceipts: {
          where: { method: "RETEST" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            status: true,
            method: true,
            scanId: true,
            verifierVersion: true,
            evidence: true,
          },
        },
        retests: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { status: true },
        },
        fixProposals: {
          where: { deletedAt: null },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { status: true },
        },
      },
    }),
    tx.findingCandidate.findMany({
      where: {
        workspaceId: input.workspaceId,
        scanId: currentScan.id,
        targetId: input.targetId,
      },
      select: { dedupeKey: true },
    }),
    baselineScan
      ? tx.findingCandidate.findMany({
          where: {
            workspaceId: input.workspaceId,
            scanId: baselineScan.id,
            targetId: input.targetId,
          },
          select: { dedupeKey: true },
        })
      : Promise.resolve([]),
    tx.findingCandidate.count({
      where: {
        workspaceId: input.workspaceId,
        scanId: currentScan.id,
        targetId: input.targetId,
        findingId: null,
      },
    }),
    tx.scanCoverageReceipt.findMany({
      where: { scanId: currentScan.id },
      select: { scanner: true, status: true },
    }),
  ])

  const trustedRetests = await loadReceiptBackedRetestFindingIds(tx, {
    workspaceId: input.workspaceId,
    targetId: input.targetId,
    findings: findings.filter((finding) => finding.status === "FIXED"),
  })
  const remediation = classifyReleaseFindings({
    findings: findings.map((finding) => {
      const retest = finding.retests[0]
      const trustedRetest = trustedRetests.has(finding.id)
      const retestState: ReleasePacketFinding["retestState"] = trustedRetest
        ? "trusted"
        : retest?.status === "pending" || retest?.status === "running"
          ? "pending"
          : retest?.status === "failed" || retest?.status === "error"
            ? "failed"
            : retest
              ? "unsupported"
              : "none"
      return {
        id: finding.id,
        dedupeKey: finding.dedupeKey,
        title: finding.title,
        severity: finding.severity,
        status: finding.status,
        verificationStatus: finding.verificationStatus,
        sourceRevision: finding.baseCommit,
        baseCommit: finding.baseCommit,
        firstSeenAt: finding.firstSeenAt,
        lastSeenAt: finding.lastSeenAt,
        trustedRetest,
        retestState,
        fixProposal: finding.fixProposals[0]
          ? {
              status: finding.fixProposals[0].status,
              baseCommit: finding.baseCommit,
            }
          : null,
      }
    }),
    currentObservedKeys: new Set(currentCandidates.map((candidate) => candidate.dedupeKey)),
    baselineObservedKeys: new Set(baselineCandidates.map((candidate) => candidate.dedupeKey)),
    currentScanStartedAt: currentScan.startedAt ?? currentScan.createdAt,
    assessedIdentity: snapshot.identity,
    uncertainCandidateCount,
    detailLimit: input.detailLimit,
  })

  return { remediation, reportsCoverage }
}

function buildReleasePacketBasePayload(args: {
  context: AssessedPacketContext
  signedAssessment: SignedAssessment
  remediation: Awaited<ReturnType<typeof loadPacketRemediation>>["remediation"]
  reportsCoverage: Array<{ scanner: string; status: string }>
  now: Date
}): Omit<ReleasePacketPayload, "packetChecksum"> {
  const { context, signedAssessment, remediation, reportsCoverage, now } = args
  const { target, verdict, snapshot, applicability, currentScan, baselineScan } = context
  const completed: string[] = []
  const notApplicable: string[] = []
  const incomplete: string[] = []
  for (const receipt of reportsCoverage) {
    if (receipt.status === "COMPLETED") completed.push(receipt.scanner)
    else if (receipt.status === "NOT_APPLICABLE") notApplicable.push(receipt.scanner)
    else incomplete.push(receipt.scanner)
  }
  return {
    version: RELEASE_PACKET_VERSION,
    generatedAt: now.toISOString(),
    target: {
      id: target.id,
      name: target.name.slice(0, 160),
      type: target.type,
      environment: target.environment,
    },
    assessment: {
      verdictId: verdict.id,
      standardVersion: verdict.standardVersion,
      state: applicability.effectiveState,
      historicalState: verdict.state as ReleasePacketPayload["assessment"]["historicalState"],
      applicable: applicability.applicable,
      reasons: applicability.reasons,
      evaluatedAt: verdict.evaluatedAt.toISOString(),
      assessedIdentity: snapshot.identity,
      coverageStatement: Array.isArray(verdict.coverageStatement)
        ? verdict.coverageStatement.filter((item): item is string => typeof item === "string")
        : [],
      nonCoverage: Array.isArray(verdict.nonCoverage)
        ? (verdict.nonCoverage as ReleasePacketPayload["assessment"]["nonCoverage"])
        : [],
    },
    signedAssessment,
    remediation: {
      baselineScanId: baselineScan?.id ?? null,
      currentScanId: currentScan.id,
      counts: remediation.counts,
      findings: remediation.findings,
      truncated: remediation.truncated,
    },
    coverage: {
      completed: [...new Set(completed)].sort(),
      notApplicable: [...new Set(notApplicable)].sort(),
      incomplete: [...new Set(incomplete)].sort(),
      manifestChecksum: currentScan.resultManifest?.checksum ?? null,
    },
  }
}

async function persistReleasePacket(
  tx: ScopedTransaction,
  input: IssueReleasePacketInput,
  context: AssessedPacketContext,
  payload: ReleasePacketPayload,
  now: Date
) {
  const { target, verdict, snapshot, currentScan } = context
  const report = await tx.report.create({
    data: {
      workspaceId: input.workspaceId,
      scanId: currentScan.id,
      type: "release_packet",
      title: `LyraShield Release Packet — ${target.name}`.slice(0, 160),
      status: "generated",
      format: "html",
      contentJson: payload,
      provenanceJson: {
        version: RELEASE_PACKET_VERSION,
        targetId: target.id,
        verdictId: verdict.id,
        scanId: currentScan.id,
        assessedIdentity: snapshot.identity,
        generatedAt: now.toISOString(),
      },
      createdById: input.actorUserId,
    },
    select: { id: true },
  })
  return report.id
}

/**
 * Issue one immutable private release packet from a stored gate verdict and
 * its evidence. The packet never recomputes readiness and never promotes a
 * missing/foreign retest into resolution.
 */
export async function issueReleasePacket(
  input: IssueReleasePacketInput
): Promise<{ reportId: string; payload: ReleasePacketPayload }> {
  const now = input.now ?? new Date()
  return withWorkspaceRLS(
    input.workspaceId,
    async (tx) => {
      const context = await loadAssessedPacketContext(tx, input, now)
      const { remediation, reportsCoverage } = await loadPacketRemediation(tx, input, context)
      const signedAssessment = await signedAssessmentFor(tx, {
        workspaceId: input.workspaceId,
        verdictId: context.verdict.id,
        identity: context.snapshot.identity,
        publicKey: input.signingPublicKey ?? null,
        now,
      })
      const basePayload = buildReleasePacketBasePayload({
        context,
        signedAssessment,
        remediation,
        reportsCoverage,
        now,
      })
      const payload: ReleasePacketPayload = {
        ...basePayload,
        packetChecksum: await computeReleasePacketChecksum(basePayload),
      }
      const reportId = await persistReleasePacket(tx, input, context, payload, now)
      return { reportId, payload }
    },
    { isolationLevel: "RepeatableRead" }
  )
}

const SHARE_TOKEN_PATTERN = /^[a-f0-9]{64}$/i

export interface ReleasePacketReadOptions {
  /** Reuse a caller-owned RLS transaction so authorization and content share one snapshot. */
  client?: ScopedTransaction
  /** When supplied, re-prove the private capability inside the same read transaction. */
  shareToken?: string
}

async function readReleasePacket(
  tx: ScopedTransaction,
  reportId: string,
  workspaceId: string,
  shareToken?: string
): Promise<ReleasePacketPayload | null> {
  const report = await tx.report.findFirst({
    where: { id: reportId, workspaceId, type: "release_packet", deletedAt: null },
    select: {
      contentJson: true,
      scanId: true,
      shareTokenHash: true,
      shareExpiresAt: true,
      revokedAt: true,
    },
  })
  if (!report) return null

  if (shareToken !== undefined) {
    if (!SHARE_TOKEN_PATTERN.test(shareToken)) return null
    const tokenHash = createHash("sha256").update(shareToken).digest("hex")
    if (
      report.shareTokenHash !== tokenHash ||
      report.revokedAt !== null ||
      (report.shareExpiresAt !== null && report.shareExpiresAt.getTime() <= Date.now())
    ) {
      return null
    }
  }

  const parsed = ReleasePacketPayloadSchema.safeParse(report.contentJson)
  if (!parsed.success) {
    throw new ReleasePacketError(
      "SNAPSHOT_INVALID",
      "The stored release packet is invalid or incomplete"
    )
  }
  // The packet's finding/coverage snapshot must belong to the same scan that
  // binds the report to a target; otherwise delegated scope could be checked
  // against one scan while the content came from another.
  if (report.scanId === null || parsed.data.remediation.currentScanId !== report.scanId) {
    throw new ReleasePacketError(
      "SNAPSHOT_INVALID",
      "The stored release packet is not bound to its assessed scan"
    )
  }
  const { packetChecksum, ...basePayload } = parsed.data
  const expectedChecksum = await computeReleasePacketChecksum(basePayload)
  if (packetChecksum !== expectedChecksum) {
    throw new ReleasePacketError(
      "SNAPSHOT_INVALID",
      "The stored release packet checksum does not match its content"
    )
  }
  return parsed.data
}

export async function getReleasePacket(
  reportId: string,
  workspaceId: string,
  options: ReleasePacketReadOptions = {}
): Promise<ReleasePacketPayload | null> {
  const read = (tx: ScopedTransaction) =>
    readReleasePacket(tx, reportId, workspaceId, options.shareToken)
  return options.client
    ? read(options.client)
    : withWorkspaceRLS(workspaceId, read, { isolationLevel: "RepeatableRead" })
}

export interface DelegatedReleasePacketReadInput {
  reportId: string
  workspaceId: string
  userId: string
  connectionId: string
  authorizationVersion: number
  shareToken?: string
}

/**
 * Read a private release packet under the requesting OAuth connection's live
 * authority. The stored report→scan binding, the connection grant row, and the
 * packet content are all read in one RepeatableRead RLS transaction, so
 * revocation, grant narrowing, target re-binding, and token revocation cannot
 * race the authorization check. Any unprovable binding fails closed.
 */
export async function getReleasePacketForDelegatedRead(
  input: DelegatedReleasePacketReadInput
): Promise<ReleasePacketPayload | null> {
  return withWorkspaceRLS(
    input.workspaceId,
    async (tx) => {
      const binding = await resolveReportDelegationTarget(input.reportId, input.workspaceId, {
        client: tx,
        withProfile: true,
      })
      if (!binding?.targetId || !binding.profile) return null

      const [authority] = await tx.$queryRaw<
        Array<{ allTargets: boolean; allowedTargetIds: string[]; allowedProfiles: string[] }>
      >`
        SELECT c."allTargets", c."allowedTargetIds", c."allowedProfiles"
        FROM "agent_connections" c
        WHERE c.id = ${input.connectionId}
          AND c."workspaceId" = ${input.workspaceId}
          AND c."userId" = ${input.userId}
          AND c.status = 'ACTIVE'
          AND c."authorizationVersion" = ${input.authorizationVersion}
          AND (c."expiresAt" IS NULL OR c."expiresAt" > clock_timestamp())
          AND c.scopes && ARRAY['lyrashield.read', 'lyrashield.write']::text[]
        LIMIT 1
        FOR SHARE
      `
      if (!authority) return null
      if (!authority.allTargets && !authority.allowedTargetIds.includes(binding.targetId)) {
        return null
      }
      const profile = binding.profile.toUpperCase()
      if (!authority.allowedProfiles.map((item) => item.toUpperCase()).includes(profile)) {
        return null
      }

      return readReleasePacket(tx, input.reportId, input.workspaceId, input.shareToken)
    },
    { isolationLevel: "RepeatableRead" }
  )
}

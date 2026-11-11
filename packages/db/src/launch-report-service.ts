/**
 * Launch Readiness Report service (WP4).
 *
 * Generates the shareable report a customer can forward to a third party,
 * rendering the WP2 GateVerdict. The public payload is built ONLY through
 * buildLaunchReportPayload (the allowlist constructor — its regression test is
 * load-bearing) and is signed so a third party can verify it was not edited
 * after issue.
 *
 * All reads go through withWorkspaceRLS. The report is a frozen artifact: the
 * payload stored at issue is never rewritten (revocation expires it; a re-share
 * re-evaluates the gate first).
 *
 * Issue-time binding (release legibility): the report records WHICH verdict it
 * describes — the selected GateVerdict's id, checksum, assessment version, and
 * retained release identity — plus the applicability outcome evaluated at issue
 * against that exact verdict. That private provenance lives on
 * Report.provenanceJson, outside the signed public payload, so it cannot alter
 * the checksum or leak into shared renderers.
 */

import { timingSafeEqual } from "node:crypto"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import { withWorkspaceRLS, type ScopedTransaction } from "./rls"
import { evaluateVerdictApplicability, parseAssessmentSnapshot } from "./gate-service"
import { isDeepStrictEqual } from "node:util"
import type { GateApplicabilityResult } from "@lyrashield/gate"
import {
  buildLaunchReportPayload,
  type LaunchReportShareablePayload,
  type LaunchReportSource,
  type LaunchReportVerdictLabel,
} from "./launch-report-payload"
import {
  buildLaunchReportProvenance,
  parseLaunchReportProvenance,
  APPLICABILITY_EVALUATION_FAILED,
  type LaunchReportProvenance,
} from "./launch-report-provenance"
import { signLaunchReportChecksum, LAUNCH_REPORT_SIGNING_KEY_ID } from "./launch-report-signing"
import { isLaunchReportShareablePayload } from "./launch-report-html"
import type { GateVerdict, Prisma } from "./generated/prisma"

export interface LaunchReportResult {
  reportId: string
  payload: LaunchReportShareablePayload
}

async function persistLaunchReport(
  tx: ScopedTransaction,
  data: {
    workspaceId: string
    createdById: string
    contentJson: Prisma.InputJsonValue
    provenanceJson: Prisma.InputJsonValue
  }
) {
  return tx.report.create({
    data: {
      workspaceId: data.workspaceId,
      type: "launch_readiness",
      title: "LyraShield Launch Readiness Report",
      status: "generated",
      format: "html",
      createdById: data.createdById,
      contentJson: data.contentJson,
      provenanceJson: data.provenanceJson,
    },
    select: { id: true },
  })
}

export type ReleaseIdentityConfirmation = "MATCH" | "MISMATCH" | "UNAVAILABLE"

/**
 * Generate a signed Launch Readiness Report for a target from its latest
 * persisted gate verdict. Returns null when the target has no verdict yet.
 *
 * Consistency contract: the verdict selection and every applicability input
 * (policy fingerprint, newer-attempt, evidence drift, freshness) are read
 * inside ONE RepeatableRead transaction, so they describe a single database
 * snapshot. `applicabilityCheckedAt` is the timestamp evaluated at that
 * snapshot. The report row is then written in a second transaction carrying
 * exactly that verdict's binding — a concurrent newer verdict can never mix
 * one verdict's counts with another's identity or applicability.
 *
 * Failure contract: when the verdict row was selected but the evaluation read
 * failed, the report still issues — explicitly non-current (stale) with
 * private applicability "unknown". When the selection itself fails, issuance
 * fails: a report with no bound verdict is not an honest artifact.
 *
 * @param opts.appDisplayName  Customer-opted-in app name. Omit for the neutral
 *   label ("a protected application") — we never name the app by default.
 * @param opts.signingPrivateKey  Signing key resolved by the caller (env in
 *   dev, Azure Key Vault in production); omitted -> env fallback -> unsigned.
 */
export class UntrustedGateEvidenceError extends Error {
  readonly code = "UNTRUSTED_GATE_EVIDENCE"
  constructor() {
    super("The stored gate verdict needs a fresh assessment before a report can be issued.")
    this.name = "UntrustedGateEvidenceError"
  }
}

export async function generateLaunchReport(
  workspaceId: string,
  targetId: string,
  createdById: string,
  opts: {
    appDisplayName?: string
    signingPrivateKey?: string
    now?: Date
    client?: ScopedTransaction
  } = {}
): Promise<LaunchReportResult | null> {
  // Phase A — one consistent observation of verdict + applicability inputs.
  // `applicabilityCheckedAt` is the instant the evaluator observed at the
  // snapshot; it is recorded even when the evaluation fails mid-transaction.
  const applicabilityCheckedAt = opts.now ?? new Date()
  const selection: {
    verdict: GateVerdict | null
    applicability: GateApplicabilityResult | null
  } = { verdict: null, applicability: null }
  try {
    const read = async (tx: ScopedTransaction) => {
      const selected = await tx.gateVerdict.findFirst({
        where: {
          workspaceId,
          targetId,
          target: { workspaceId, deletedAt: null },
        },
        // id tiebreaker for same-millisecond verdicts (see getLatestGateVerdict).
        orderBy: [{ evaluatedAt: "desc" }, { id: "desc" }],
      })
      // Captured outside the callback so a later statement failure in this
      // transaction still leaves the selected binding available.
      selection.verdict = selected
      if (!selected) return
      selection.applicability = await evaluateVerdictApplicability(tx, workspaceId, selected, {
        now: applicabilityCheckedAt,
      })
    }
    if (opts.client) await read(opts.client)
    else
      await withWorkspaceRLS(
        workspaceId,
        read,
        // RepeatableRead pins every statement to one snapshot: the verdict, the
        // policy fingerprint, and the drift checks can never disagree about the
        // database instant they describe.
        { isolationLevel: "RepeatableRead" }
      )
  } catch (error) {
    if (!selection.verdict) throw error
    // The verdict was selected; only the evaluation failed. Issue an honest
    // non-current report instead of falling back to the stored staleness flag
    // (which could read "current" for an assessment that no longer is).
    logger.warn(
      "Launch report issue-time applicability evaluation failed; issuing non-current report",
      {
        workspaceId,
        targetId,
        gateVerdictId: selection.verdict.id,
        error: error instanceof Error ? error.name : "unknown",
      }
    )
  }
  const verdict = selection.verdict
  const applicability = selection.applicability
  if (!verdict) return null
  if (applicability?.reasons.some((reason) => reason.code === "UNTRUSTED_GATE_EVIDENCE")) {
    throw new UntrustedGateEvidenceError()
  }

  const issuedAt = opts.now ?? new Date()

  const source = reportSourceFromVerdict(verdict, applicability?.applicable === true)

  const payload = buildLaunchReportPayload(source, {
    appDisplayName: opts.appDisplayName,
    issuedAt,
  })

  // Sign the payload checksum when a signing key is available. The key is
  // resolved by the caller (env in dev, Azure Key Vault in production) and
  // injected; without it the report is still issued (checksum present,
  // signature absent) and the verification endpoint reports unsigned.
  let signature: string | undefined
  const privateKey = opts.signingPrivateKey ?? env.LAUNCH_REPORT_SIGNING_PRIVATE_KEY
  if (privateKey) {
    signature = signLaunchReportChecksum(payload.reportChecksum, privateKey)
    payload.signature = signature
    payload.signingKeyId = LAUNCH_REPORT_SIGNING_KEY_ID
  }

  // Assessed identity comes from the bound verdict's assessment snapshot —
  // never from a caller-supplied release identity (issuance enforces none) and
  // never reconstructed from the target's current branch or latest scan.
  const snapshot = parseAssessmentSnapshot(verdict.assessmentSnapshot)
  const provenance = buildLaunchReportProvenance({
    verdictId: verdict.id,
    verdictChecksum: verdict.verdictChecksum,
    assessmentVersion: verdict.assessmentVersion,
    assessedIdentity: snapshot?.identity ?? null,
    assessedAt: verdict.evaluatedAt,
    issuedAt,
    applicabilityCheckedAt,
    applicability: applicability
      ? applicability.applicable
        ? "applicable"
        : "not_applicable"
      : "unknown",
    reasonCodes: applicability
      ? applicability.reasons.map((reason) => reason.code)
      : [APPLICABILITY_EVALUATION_FAILED],
    historicalState: verdict.state,
    effectiveState: applicability?.effectiveState ?? null,
  })

  // Phase B — payload + private provenance are written atomically in one row.
  const persist = (tx: ScopedTransaction) =>
    persistLaunchReport(tx, {
      workspaceId,
      createdById,
      contentJson: { ...payload },
      provenanceJson: { ...provenance },
    })
  const report = opts.client
    ? await persist(opts.client)
    : await withWorkspaceRLS(workspaceId, persist)

  logger.info("Launch readiness report generated", {
    reportId: report.id,
    workspaceId,
    targetId,
    gateVerdictId: verdict.id,
    state: payload.verdictLabel,
    applicability: provenance.applicability,
    signed: Boolean(signature),
  })

  return { reportId: report.id, payload }
}

function reportSourceFromVerdict(verdict: GateVerdict, current: boolean): LaunchReportSource {
  // Stored evidenceSummary comes from the gate's versioned output. Verdicts
  // persisted before the per-severity counts existed lack
  // unresolvedCritical/unresolvedHigh — a missing value reading as 0 would
  // silently understate unresolved work, so re-derive from blockingReasons
  // (which carried the CRITICAL/HIGH truth for those older verdicts).
  const storedSummary = verdict.evidenceSummary as LaunchReportSource["evidenceSummary"] & {
    unresolvedCritical?: number
    unresolvedHigh?: number
  }
  const blockingReasons = verdict.blockingReasons as LaunchReportSource["blockingReasons"]
  const legacyCritical = blockingReasons.filter((b) => b.severity === "CRITICAL").length
  const legacyHigh = blockingReasons.filter((b) => b.severity === "HIGH").length
  const evidenceSummary: LaunchReportSource["evidenceSummary"] = {
    verified: storedSummary.verified,
    retestConfirmed: storedSummary.retestConfirmed,
    unresolvedMedium: storedSummary.unresolvedMedium,
    unresolvedLow: storedSummary.unresolvedLow,
    acceptedRisk: storedSummary.acceptedRisk,
    falsePositive: storedSummary.falsePositive,
    unresolvedCritical:
      typeof storedSummary.unresolvedCritical === "number"
        ? storedSummary.unresolvedCritical
        : legacyCritical,
    unresolvedHigh:
      typeof storedSummary.unresolvedHigh === "number" ? storedSummary.unresolvedHigh : legacyHigh,
  }

  // `stale` now means "not applicable at issue": expired, policy drift, newer
  // attempt, evidence drift, missing binding — or "unknown" when the check
  // itself failed. The stored staleness snapshot is never trusted: it freezes
  // whatever was true when the verdict was computed, not when the report
  // issues.

  return {
    standardVersion: verdict.standardVersion,
    state: verdict.state as LaunchReportSource["state"],
    coverageStatement: verdict.coverageStatement as string[],
    nonCoverage: verdict.nonCoverage as LaunchReportSource["nonCoverage"],
    blockingReasons,
    evidenceSummary,
    staleness: { current },
    verdictChecksum: verdict.verdictChecksum,
    evaluatedAt: verdict.evaluatedAt,
  }
}

/** A signed report remains immutable; only its current presentation is qualified. */
async function reportEvidenceMatches(
  tx: ScopedTransaction,
  workspaceId: string,
  provenance: LaunchReportProvenance | null,
  payload: LaunchReportShareablePayload
): Promise<boolean> {
  if (!provenance || provenance.applicability !== "applicable") return false
  try {
    const verdict = await tx.gateVerdict.findFirst({
      where: { id: provenance.gateVerdictId, workspaceId },
    })
    const snapshot = verdict ? parseAssessmentSnapshot(verdict.assessmentSnapshot) : null
    if (
      !verdict ||
      verdict.verdictChecksum !== provenance.verdictChecksum ||
      verdict.assessmentVersion !== provenance.assessmentVersion ||
      verdict.evaluatedAt.toISOString() !== provenance.assessedAt ||
      verdict.state !== provenance.historicalState ||
      !isDeepStrictEqual(snapshot?.identity ?? null, provenance.assessedIdentity) ||
      payload.issuedAt !== provenance.issuedAt
    )
      return false
    const expected = buildLaunchReportPayload(reportSourceFromVerdict(verdict, true), {
      appDisplayName: payload.appDisplayName,
      issuedAt: new Date(provenance.issuedAt),
    })
    if (expected.reportChecksum !== payload.reportChecksum) return false
    return (await evaluateVerdictApplicability(tx, workspaceId, verdict)).applicable
  } catch {
    return false
  }
}

/**
 * Private detail for the authenticated report reader: the frozen issue-time
 * binding plus the payload's public verdict label. Returns null when the
 * report does not exist in the workspace or is not a launch_readiness report.
 * `provenance` is null for reports issued before the binding existed —
 * callers must render "Release identity unavailable for this report", never
 * reconstruct it from the target's current state.
 */
export async function getLaunchReportDetail(
  reportId: string,
  workspaceId: string,
  client?: ScopedTransaction
): Promise<{
  verdictLabel: LaunchReportVerdictLabel | null
  stale: boolean
  currentApplicability: "UNKNOWN"
  provenance: LaunchReportProvenance | null
} | null> {
  const read = async (tx: ScopedTransaction) => {
    const report = await tx.report.findFirst({
      where: { id: reportId, workspaceId, deletedAt: null },
      select: { type: true, contentJson: true, provenanceJson: true },
    })
    if (!report || report.type !== "launch_readiness") return null
    const content: unknown = report.contentJson
    if (!isLaunchReportShareablePayload(content)) {
      return {
        verdictLabel: null,
        stale: true,
        currentApplicability: "UNKNOWN" as const,
        provenance: null,
      }
    }
    const payload = content
    const provenance = parseLaunchReportProvenance(report.provenanceJson)
    const expired =
      !Number.isFinite(Date.parse(payload.expiresAt ?? "")) ||
      Date.parse(payload.expiresAt ?? "") <= Date.now()
    const stale =
      payload.stale ||
      expired ||
      !(await reportEvidenceMatches(tx, workspaceId, provenance, payload))
    return {
      verdictLabel: payload.verdictLabel,
      stale,
      currentApplicability: "UNKNOWN" as const,
      provenance,
    }
  }
  return client
    ? read(client)
    : withWorkspaceRLS(workspaceId, read, { isolationLevel: "RepeatableRead" })
}

/**
 * Read the frozen payload for a shared launch report, gated by share token.
 * The token is the public capability (same model as getReportByShareToken);
 * the report id must also match so a token for one report cannot read another.
 * Returns null for an unknown, revoked, or expired report — fail closed.
 */
export async function getSharedLaunchReport(
  reportId: string,
  token: string
): Promise<{ payload: LaunchReportShareablePayload; stale: boolean } | null> {
  const { getReportByShareToken, readActiveSharedReport } = await import("./report-service")
  const resolved = await getReportByShareToken(token)
  if (!resolved || resolved.id !== reportId) return null

  return withWorkspaceRLS(
    resolved.workspaceId,
    async (tx) => {
      const report = await readActiveSharedReport(tx, resolved.workspaceId, reportId, token)
      if (!report || report.type !== "launch_readiness") return null
      const content: unknown = report.contentJson
      if (!isLaunchReportShareablePayload(content)) return null
      const payload = content
      const expiresAtMs = payload.expiresAt ? new Date(payload.expiresAt).getTime() : Number.NaN
      // Stored bytes and their signature remain immutable. This is a read-time
      // presentation flag so legacy or expired reports never render as current.
      if (payload.stale || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        return { payload, stale: true }
      }
      const provenance = parseLaunchReportProvenance(report.provenanceJson)
      if (!(await reportEvidenceMatches(tx, resolved.workspaceId, provenance, payload))) {
        return { payload, stale: true }
      }
      return { payload, stale: false }
    },
    { isolationLevel: "RepeatableRead" }
  )
}

/**
 * Confirm, but never disclose, the release identity bound to a shared report.
 *
 * The share token is the disclosure capability. Unknown, expired, revoked,
 * cross-report, legacy, and checksum-mismatched requests deliberately collapse
 * to UNAVAILABLE so this helper cannot be used to enumerate reports or stored
 * release identities.
 */
export async function confirmSharedLaunchReportIdentity(input: {
  reportId: string
  token: string
  reportChecksum: string
  identity: { kind: "COMMIT" | "ARTIFACT_DIGEST"; value: string }
}): Promise<ReleaseIdentityConfirmation> {
  const { getReportByShareToken, readActiveSharedReport } = await import("./report-service")
  const resolved = await getReportByShareToken(input.token)
  if (!resolved?.shareExpiresAt || resolved.id !== input.reportId) return "UNAVAILABLE"

  return withWorkspaceRLS(resolved.workspaceId, async (tx) => {
    const report = await readActiveSharedReport(
      tx,
      resolved.workspaceId,
      input.reportId,
      input.token
    )
    if (!report || report.type !== "launch_readiness" || !report.shareExpiresAt)
      return "UNAVAILABLE"

    const content: unknown = report.contentJson
    if (!isLaunchReportShareablePayload(content)) return "UNAVAILABLE"
    const payload = content
    const provenance = parseLaunchReportProvenance(report.provenanceJson)
    if (
      payload.reportChecksum !== input.reportChecksum ||
      !provenance?.assessedIdentity ||
      provenance.assessedIdentity.kind !== input.identity.kind
    ) {
      return "UNAVAILABLE"
    }

    const expected = Buffer.from(provenance.assessedIdentity.value.toLowerCase(), "utf8")
    const supplied = Buffer.from(input.identity.value.toLowerCase(), "utf8")
    return expected.length === supplied.length && timingSafeEqual(expected, supplied)
      ? "MATCH"
      : "MISMATCH"
  })
}

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
 */

import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import { withWorkspaceRLS } from "./rls"
import {
  buildLaunchReportPayload,
  type LaunchReportShareablePayload,
  type LaunchReportSource,
} from "./launch-report-payload"
import { signLaunchReportChecksum, LAUNCH_REPORT_SIGNING_KEY_ID } from "./launch-report-signing"

export interface LaunchReportResult {
  reportId: string
  payload: LaunchReportShareablePayload
}

/**
 * Generate a signed Launch Readiness Report for a target from its latest
 * persisted gate verdict. Returns null when the target has no verdict yet.
 *
 * @param opts.appDisplayName  Customer-opted-in app name. Omit for the neutral
 *   label ("a protected application") — we never name the app by default.
 * @param opts.signingPrivateKey  Signing key resolved by the caller (env in
 *   dev, Azure Key Vault in production); omitted -> env fallback -> unsigned.
 */
export async function generateLaunchReport(
  workspaceId: string,
  targetId: string,
  createdById: string,
  opts: { appDisplayName?: string; signingPrivateKey?: string } = {}
): Promise<LaunchReportResult | null> {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const verdict = await tx.gateVerdict.findFirst({
      where: { workspaceId, targetId },
      // id tiebreaker for same-millisecond verdicts (see getLatestGateVerdict).
      orderBy: [{ evaluatedAt: "desc" }, { id: "desc" }],
    })
    if (!verdict) return null

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
      unresolvedCritical:
        typeof storedSummary.unresolvedCritical === "number"
          ? storedSummary.unresolvedCritical
          : legacyCritical,
      unresolvedHigh:
        typeof storedSummary.unresolvedHigh === "number"
          ? storedSummary.unresolvedHigh
          : legacyHigh,
    }

    const source: LaunchReportSource = {
      standardVersion: verdict.standardVersion,
      state: verdict.state as LaunchReportSource["state"],
      coverageStatement: verdict.coverageStatement as string[],
      nonCoverage: verdict.nonCoverage as LaunchReportSource["nonCoverage"],
      blockingReasons,
      evidenceSummary,
      staleness: verdict.staleness as LaunchReportSource["staleness"],
      verdictChecksum: verdict.verdictChecksum,
      evaluatedAt: verdict.evaluatedAt,
    }

    const payload = buildLaunchReportPayload(source, { appDisplayName: opts.appDisplayName })

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

    const report = await tx.report.create({
      data: {
        workspaceId,
        type: "launch_readiness",
        title: "LyraShield Launch Readiness Report",
        status: "generated",
        format: "html",
        createdById,
        contentJson: payload as unknown as Record<string, unknown>,
      },
      select: { id: true },
    })

    logger.info("Launch readiness report generated", {
      reportId: report.id,
      workspaceId,
      targetId,
      state: payload.verdictLabel,
      signed: Boolean(signature),
    })

    return { reportId: report.id, payload }
  })
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
): Promise<LaunchReportShareablePayload | null> {
  const { getReportByShareToken } = await import("./report-service")
  const resolved = await getReportByShareToken(token)
  if (!resolved || resolved.id !== reportId) return null

  return withWorkspaceRLS(resolved.workspaceId, async (tx) => {
    const report = await tx.report.findFirst({
      where: { id: reportId, workspaceId: resolved.workspaceId, deletedAt: null },
      select: { contentJson: true, type: true },
    })
    if (!report || report.type !== "launch_readiness") return null
    return report.contentJson as unknown as LaunchReportShareablePayload
  })
}

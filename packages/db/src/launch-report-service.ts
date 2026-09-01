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
 */
export async function generateLaunchReport(
  workspaceId: string,
  targetId: string,
  createdById: string,
  opts: { appDisplayName?: string } = {}
): Promise<LaunchReportResult | null> {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const verdict = await tx.gateVerdict.findFirst({
      where: { workspaceId, targetId },
      orderBy: { evaluatedAt: "desc" },
    })
    if (!verdict) return null

    const source: LaunchReportSource = {
      standardVersion: verdict.standardVersion,
      state: verdict.state as LaunchReportSource["state"],
      coverageStatement: verdict.coverageStatement as string[],
      nonCoverage: verdict.nonCoverage as LaunchReportSource["nonCoverage"],
      blockingReasons: verdict.blockingReasons as LaunchReportSource["blockingReasons"],
      evidenceSummary: verdict.evidenceSummary as LaunchReportSource["evidenceSummary"],
      staleness: verdict.staleness as LaunchReportSource["staleness"],
      verdictChecksum: verdict.verdictChecksum,
      evaluatedAt: verdict.evaluatedAt,
    }

    const payload = buildLaunchReportPayload(source, { appDisplayName: opts.appDisplayName })

    // Sign the payload checksum when the signing key is configured. Without a
    // key the report is still issued (checksum present, signature absent) — the
    // verification endpoint reports it as unsigned rather than failing.
    let signature: string | undefined
    const privateKey = env.LAUNCH_REPORT_SIGNING_PRIVATE_KEY
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

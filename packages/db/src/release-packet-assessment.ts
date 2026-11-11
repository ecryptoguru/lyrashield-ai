import type { SignedAssessment } from "@lyrashield/types"
import type { ScopedTransaction } from "./rls"
import { isLaunchReportShareablePayload } from "./launch-report-html"
import { parseLaunchReportProvenance } from "./launch-report-provenance"
import { LAUNCH_REPORT_SIGNING_KEY_ID, verifyLaunchReportSignature } from "./launch-report-signing"
import { assessmentKeyStatus, type ReleasePacketVerificationKey } from "./release-packet-signing"

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

export async function signedAssessmentFor(
  tx: ScopedTransaction,
  input: {
    workspaceId: string
    verdictId: string
    identity: { kind: "COMMIT" | "ARTIFACT_DIGEST"; value: string } | null
    publicKey: string | null
    verificationKeys: readonly ReleasePacketVerificationKey[]
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
  const expiresAt = payload.expiresAt ? new Date(payload.expiresAt).getTime() : Number.NaN
  const common = {
    reportId: report.id,
    reportChecksum: payload.reportChecksum,
    signature: payload.signature,
    signingKeyId: payload.signingKeyId,
    verifiedAt: input.now.toISOString(),
    ...(Number.isFinite(expiresAt) ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
  }
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
  if (
    !input.publicKey ||
    payload.signingKeyId !== LAUNCH_REPORT_SIGNING_KEY_ID ||
    assessmentKeyStatus(input.publicKey, input.verificationKeys) !== "ALLOWED"
  ) {
    return { ...common, state: "UNAVAILABLE", reason: "The verification key is unavailable." }
  }
  return verifyLaunchReportSignature(payload.reportChecksum, payload.signature, input.publicKey)
    ? { ...common, state: "SIGNED" }
    : { state: "INVALID", ...common, reason: "The bound assessment signature is invalid." }
}

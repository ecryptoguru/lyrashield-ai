import {
  resolveLaunchReportSigningPublicKey,
  resolveReleasePacketVerificationKeys,
} from "@lyrashield/billing"
import type { ReleasePacketReadResult } from "@lyrashield/db"

/** Missing or invalid public keys remain unavailable; they never authorize a signature. */
export async function releasePacketVerificationContext() {
  const [verificationKeys, assessmentPublicKey] = await Promise.all([
    resolveReleasePacketVerificationKeys().catch(() => []),
    resolveLaunchReportSigningPublicKey().catch(() => null),
  ])
  return { verificationKeys, assessmentPublicKey }
}

export function isReleasePacketExportable(result: ReleasePacketReadResult): boolean {
  return (
    result.authenticity.signatureState === "VERIFIED" ||
    result.authenticity.signatureState === "HISTORICAL_UNSIGNED"
  )
}

import {
  computeReleasePacketChecksum,
  LEGACY_RELEASE_PACKET_VERSION,
  type ReleasePacketPayload,
} from "@lyrashield/types"
import { LAUNCH_REPORT_SIGNING_KEY_ID, verifyLaunchReportSignature } from "./launch-report-signing"
import {
  assessmentKeyStatus,
  verifyReleasePacketChecksum,
  type ReleasePacketVerificationKey,
} from "./release-packet-signing"

export interface ReleasePacketAuthenticity {
  signatureState:
    "VERIFIED" | "INVALID" | "REVOKED" | "UNAVAILABLE" | "UNSIGNED" | "HISTORICAL_UNSIGNED"
  expiresAt: string | null
  expired: boolean | null
  checkedAt: string
}

export interface ReleaseAssessmentValidity {
  signatureState: "VERIFIED" | "INVALID" | "REVOKED" | "UNAVAILABLE" | "UNSIGNED"
  expiresAt: string | null
  expired: boolean | null
}

export async function evaluatePacketAuthenticity(
  packet: ReleasePacketPayload,
  keys: readonly ReleasePacketVerificationKey[],
  now: Date
): Promise<ReleasePacketAuthenticity> {
  if ((await computeReleasePacketChecksum(packet)) !== packet.packetChecksum) {
    return {
      signatureState: "INVALID",
      expiresAt: packet.expiresAt ?? null,
      expired: null,
      checkedAt: now.toISOString(),
    }
  }
  if (packet.version === LEGACY_RELEASE_PACKET_VERSION) {
    return {
      signatureState: "HISTORICAL_UNSIGNED",
      expiresAt: null,
      expired: null,
      checkedAt: now.toISOString(),
    }
  }
  const signatureState =
    packet.packetSignature && packet.signingKeyId
      ? verifyReleasePacketChecksum(
          packet.packetChecksum,
          packet.packetSignature,
          packet.signingKeyId,
          keys
        )
      : "UNSIGNED"
  const expiresAt = packet.expiresAt ?? null
  return {
    signatureState,
    expiresAt,
    expired: expiresAt ? Date.parse(expiresAt) <= now.getTime() : null,
    checkedAt: now.toISOString(),
  }
}

export function evaluateAssessmentValidity(
  packet: ReleasePacketPayload,
  publicKey: string | null,
  keys: readonly ReleasePacketVerificationKey[],
  now: Date
): ReleaseAssessmentValidity {
  const assessment = packet.signedAssessment
  let signatureState: ReleaseAssessmentValidity["signatureState"] = "UNSIGNED"
  if (assessment.signature) {
    if (!publicKey || assessment.signingKeyId !== LAUNCH_REPORT_SIGNING_KEY_ID) {
      signatureState = "UNAVAILABLE"
    } else {
      const status = assessmentKeyStatus(publicKey, keys)
      signatureState =
        status !== "ALLOWED"
          ? status
          : assessment.reportChecksum &&
              verifyLaunchReportSignature(
                assessment.reportChecksum,
                assessment.signature,
                publicKey
              )
            ? "VERIFIED"
            : "INVALID"
    }
  }
  const expiresAt = assessment.expiresAt ?? null
  return {
    signatureState,
    expiresAt,
    expired: expiresAt ? Date.parse(expiresAt) <= now.getTime() : null,
  }
}

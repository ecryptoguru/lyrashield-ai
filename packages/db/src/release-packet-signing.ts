import { createHash, createPublicKey } from "node:crypto"
import { signLaunchReportChecksum, verifyLaunchReportSignature } from "./launch-report-signing"

export interface ReleasePacketVerificationKey {
  id: string
  publicKey: string
  revoked: boolean
}

const CHECKSUM = /^[a-f0-9]{64}$/
const signingMessage = (checksum: string) => `lyrashield-release-packet/1.1.0:${checksum}`

/** Bind the identifier to the actual Ed25519 public key rather than a mutable label. */
export function releasePacketSigningKeyId(publicOrPrivateKey: string): string {
  const key = createPublicKey(publicOrPrivateKey)
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Release packets require an Ed25519 key")
  const fingerprint = createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex")
  return `lyrashield-packet-ed25519-${fingerprint}`
}

export function signReleasePacketChecksum(checksum: string, privateKey: string): string {
  if (!CHECKSUM.test(checksum)) throw new Error("Invalid release packet checksum")
  return signLaunchReportChecksum(signingMessage(checksum), privateKey)
}

/** Apply the same trusted keyring and revocation policy to the shared assessment key. */
export function assessmentKeyStatus(
  publicKey: string,
  keys: readonly ReleasePacketVerificationKey[]
): "ALLOWED" | "REVOKED" | "UNAVAILABLE" | "INVALID" {
  try {
    const id = releasePacketSigningKeyId(publicKey)
    const matches = keys.filter((key) => key.id === id)
    if (matches.length === 0) return "UNAVAILABLE"
    if (matches.length !== 1 || releasePacketSigningKeyId(matches[0]!.publicKey) !== id) {
      return "INVALID"
    }
    return matches[0]!.revoked ? "REVOKED" : "ALLOWED"
  } catch {
    return "INVALID"
  }
}

/** The caller provides an independently configured allowlist, including revocations. */
export function verifyReleasePacketChecksum(
  checksum: string,
  signature: string,
  keyId: string,
  keys: readonly ReleasePacketVerificationKey[]
): "VERIFIED" | "INVALID" | "REVOKED" | "UNAVAILABLE" {
  if (!CHECKSUM.test(checksum)) return "INVALID"
  const matches = keys.filter((key) => key.id === keyId)
  if (matches.length === 0) return "UNAVAILABLE"
  if (matches.length !== 1) return "INVALID"
  const key = matches[0]!
  if (key.revoked) return "REVOKED"
  try {
    const bytes = Buffer.from(signature, "base64")
    if (
      bytes.length !== 64 ||
      bytes.toString("base64") !== signature ||
      releasePacketSigningKeyId(key.publicKey) !== keyId
    )
      return "INVALID"
    return verifyLaunchReportSignature(signingMessage(checksum), signature, key.publicKey)
      ? "VERIFIED"
      : "INVALID"
  } catch {
    return "INVALID"
  }
}

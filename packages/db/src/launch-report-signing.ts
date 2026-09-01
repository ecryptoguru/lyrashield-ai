/**
 * Launch Readiness Report signing (ed25519 via Node built-in crypto).
 *
 * Mirrors the license-signing approach (packages/licenses/src/sign.ts): the
 * signature is computed over the canonical SHA-256 checksum of the shareable
 * payload, so a third party can verify a presented document was issued by
 * LyraShield and not edited after issue.
 *
 * Founder-ruled (2026-09-02): a single published LyraShield signing key for v1.
 * The private key is provided via the LAUNCH_REPORT_SIGNING_PRIVATE_KEY env var
 * (Azure Key Vault in production); the public key is published for verification.
 */

import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto"

export const LAUNCH_REPORT_SIGNING_KEY_ID = "lyrashield-launch-report-ed25519-1"

function assertEd25519(key: KeyObject, kind: "private" | "public"): void {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`Launch report signing requires an ed25519 ${kind} key`)
  }
}

/** Sign a report checksum with the ed25519 private key (PKCS#8 PEM). Returns base64. */
export function signLaunchReportChecksum(reportChecksum: string, privateKeyPem: string): string {
  const key = createPrivateKey({ key: privateKeyPem, format: "pem" })
  assertEd25519(key, "private")
  return sign(null, Buffer.from(reportChecksum, "utf8"), key).toString("base64")
}

/**
 * Verify a report signature against the public key (SPKI PEM). Returns true only
 * when the signature covers the exact checksum — any edit to the document after
 * issue changes the checksum and fails verification.
 */
export function verifyLaunchReportSignature(
  reportChecksum: string,
  signatureBase64: string,
  publicKeyPem: string
): boolean {
  try {
    const key = createPublicKey({ key: publicKeyPem, format: "pem" })
    assertEd25519(key, "public")
    return verify(
      null,
      Buffer.from(reportChecksum, "utf8"),
      key,
      Buffer.from(signatureBase64, "base64")
    )
  } catch {
    return false
  }
}

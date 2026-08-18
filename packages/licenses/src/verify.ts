/**
 * License verification utilities (ed25519 via Node.js built-in crypto).
 *
 * The desktop client calls `verifyLicense` with the bundled public key to
 * check the signature without contacting the server (offline grace). After
 * verification, the client checks `updateEligibleUntil` to decide whether
 * newer builds may be installed. When eligibility has expired the client
 * never deactivates — it falls back to `perpetualFallbackBuild`.
 */

import { verify } from "node:crypto"
import { loadPublicKey, signingBytes } from "./sign"
import type { LicenseFile, LicenseVerificationResult, LicenseSigningInput } from "./types"

/**
 * Verify a license file's ed25519 signature against a public key (SPKI PEM).
 *
 * Returns `{ valid, updateEligible, license, reason }`. The caller is
 * responsible for checking `updateEligible` separately from `valid` — a
 * license can be validly signed but no longer eligible for updates.
 */
export function verifyLicense(
  licenseFile: LicenseFile,
  publicKeyPem: string
): LicenseVerificationResult {
  if (!licenseFile || typeof licenseFile !== "object") {
    return { valid: false, updateEligible: false, license: null, reason: "missing_license_file" }
  }

  const { signature, signingKeyId, issuedAt, ...payloadFields } = licenseFile

  if (!signature || !signingKeyId || !issuedAt) {
    return {
      valid: false,
      updateEligible: false,
      license: null,
      reason: "missing_signing_metadata",
    }
  }

  // Reconstruct the exact signing input. The signature covers only the payload
  // fields (sku, seatCount, machineIds, updateEligibleUntil,
  // perpetualFallbackBuild) — not the signature/signingKeyId/issuedAt themselves.
  const signingInput: LicenseSigningInput = {
    sku: payloadFields.sku,
    seatCount: payloadFields.seatCount,
    machineIds: payloadFields.machineIds,
    updateEligibleUntil: payloadFields.updateEligibleUntil,
    perpetualFallbackBuild: payloadFields.perpetualFallbackBuild,
  }

  let publicKey
  try {
    publicKey = loadPublicKey(publicKeyPem)
  } catch {
    return {
      valid: false,
      updateEligible: false,
      license: null,
      reason: "invalid_public_key",
    }
  }

  let signatureBuffer: Buffer
  try {
    signatureBuffer = Buffer.from(signature, "base64")
  } catch {
    return {
      valid: false,
      updateEligible: false,
      license: null,
      reason: "invalid_signature_encoding",
    }
  }

  let isValid: boolean
  try {
    isValid = verify(null, signingBytes(signingInput), publicKey, signatureBuffer)
  } catch {
    return {
      valid: false,
      updateEligible: false,
      license: null,
      reason: "verification_error",
    }
  }

  if (!isValid) {
    return { valid: false, updateEligible: false, license: null, reason: "signature_mismatch" }
  }

  const now = Date.now()
  const eligibleUntil = Date.parse(licenseFile.updateEligibleUntil)
  const updateEligible =
    !Number.isNaN(eligibleUntil) && eligibleUntil > now

  return {
    valid: true,
    updateEligible,
    license: licenseFile,
    reason: updateEligible ? undefined : "update_eligibility_expired",
  }
}

/**
 * Check whether a given build version is installable under a verified license.
 *
 * - If the license is still update-eligible, any build is allowed.
 * - If eligibility has expired, only builds <= `perpetualFallbackBuild` are
 *   allowed (the client never deactivates — it just refuses newer updates).
 *
 * Build comparison is a simple semantic string comparison; callers should pass
 * semver-style strings (e.g. "1.2.0"). Returns `false` if the fallback build
 * is null and eligibility has expired.
 */
export function isBuildInstallable(
  licenseFile: LicenseFile,
  buildVersion: string
): boolean {
  const now = Date.now()
  const eligibleUntil = Date.parse(licenseFile.updateEligibleUntil)
  const stillEligible = !Number.isNaN(eligibleUntil) && eligibleUntil > now

  if (stillEligible) return true

  if (!licenseFile.perpetualFallbackBuild) return false

  return compareVersions(buildVersion, licenseFile.perpetualFallbackBuild) <= 0
}

/** Simple semver comparison: returns -1, 0, or 1. Non-semver strings compare lexicographically. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10))
  const pb = b.split(".").map((n) => parseInt(n, 10))
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va < vb) return -1
    if (va > vb) return 1
  }
  return 0
}

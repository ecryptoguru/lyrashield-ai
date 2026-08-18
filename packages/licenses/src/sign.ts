/**
 * License signing utilities (ed25519 via Node.js built-in crypto).
 *
 * The private key is stored as a PKCS#8 PEM and the public key as a SPKI PEM.
 * In production the private key material lives in Azure Key Vault; in
 * development it is provided via the `LICENSE_SIGNING_PRIVATE_KEY` env var.
 *
 * The signature is computed over the **canonical JSON** of the license payload
 * — a deterministic serialization with sorted object keys and no insignificant
 * whitespace — so that the desktop client can reproduce the exact same bytes
 * for verification.
 */

import { createPrivateKey, createPublicKey, sign, KeyObject } from "node:crypto"
import type { LicenseFile, LicensePayload, LicenseSigningInput } from "./types"

/**
 * Produce a deterministic JSON string for signing.
 *
 * Object keys are sorted lexicographically at every depth, arrays preserve
 * insertion order (machineIds order is significant), and there is no
 * insignificant whitespace. `undefined` values are omitted; `null` is kept.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return JSON.stringify(value)
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    if (value === null) return "null"
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJSON).join(",") + "]"
  }

  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()

  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") + "}"
}

/** The exact bytes that the ed25519 signature covers. */
export function signingBytes(payload: LicenseSigningInput): Buffer {
  return Buffer.from(canonicalJSON(payload), "utf8")
}

/**
 * Sign a license payload with an ed25519 private key (PKCS#8 PEM).
 *
 * Returns a complete `LicenseFile` including the base64 signature and signing
 * metadata. The `signingKeyId` identifies which key was used so the client can
 * select the correct public key for verification and so compromised keys can be
 * revoked via a bundled revocation list.
 */
export function signLicense(
  payload: LicensePayload,
  privateKeyPem: string,
  signingKeyId: string,
  perpetualFallbackBuild: string | null
): LicenseFile {
  const privateKey = createPrivateKey({
    key: privateKeyPem,
    format: "pem",
  })

  // Guard: ed25519 is the only acceptable algorithm for license signing.
  assertEd25519Key(privateKey)

  const signingInput: LicenseSigningInput = {
    sku: payload.sku,
    seatCount: payload.seatCount,
    machineIds: [...payload.machineIds],
    updateEligibleUntil: payload.updateEligibleUntil,
    perpetualFallbackBuild: perpetualFallbackBuild,
  }

  const signature = sign(null, signingBytes(signingInput), privateKey)

  return {
    ...signingInput,
    signingKeyId,
    signature: signature.toString("base64"),
    issuedAt: new Date().toISOString(),
  }
}

/** Load an ed25519 public key from a SPKI PEM string. */
export function loadPublicKey(publicKeyPem: string): KeyObject {
  return createPublicKey({ key: publicKeyPem, format: "pem" })
}

function assertEd25519Key(key: KeyObject): void {
  const info = key.asymmetricKeyType
  if (info !== "ed25519") {
    throw new Error(
      `License signing requires an ed25519 key, received "${info ?? "unknown"}". ` +
        "Generate one with: openssl genpkey -algorithm ed25519 -out private.pem"
    )
  }
}

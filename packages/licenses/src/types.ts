/**
 * @lyrashield/licenses — License file types for the Local / Desktop app.
 *
 * A signed license file is the offline-trustable proof that a machine is
 * licensed to run LyraShield Local. It is signed with an ed25519 asymmetric
 * keypair: the private key lives in Azure Key Vault (env for dev), the public
 * key is bundled with the app. The desktop client verifies the signature
 * locally without phoning home (offline grace).
 */

/** SKU identifiers for Local licenses (mirrors @lyrashield/pricing LocalSkuId). */
export type LicenseSku =
  | "individual_launch"
  | "individual_regular"
  | "team_perpetual"
  | "team_subscription"
  | "renewal"
  | "sync_addon"

/**
 * The payload that is canonically serialized and signed with ed25519.
 *
 * The desktop client must verify this signature before trusting any license
 * state. After `updateEligibleUntil` the client refuses newer builds but never
 * deactivates — the `perpetualFallbackBuild` records the last build the user
 * is entitled to run indefinitely.
 */
export interface LicensePayload {
  /** The Local SKU that was purchased. */
  sku: LicenseSku
  /** Number of seats (1 for individual, N for team). */
  seatCount: number
  /** Machine identifiers that are activated under this license. */
  machineIds: string[]
  /** ISO-8601 date after which update eligibility expires. */
  updateEligibleUntil: string
  /** Last build the user may run in perpetuity after eligibility expires. */
  perpetualFallbackBuild: string | null
}

/**
 * The complete license file: the payload plus signing metadata and the
 * ed25519 signature over the canonical JSON of the payload.
 */
export interface LicenseFile extends LicensePayload {
  /** Identifier of the signing key (for key rotation / revocation). */
  signingKeyId: string
  /** Base64-encoded ed25519 signature over canonical JSON of the payload. */
  signature: string
  /** ISO-8601 timestamp when the license file was issued. */
  issuedAt: string
}

/** Fields used to construct the canonical signing input (payload only). */
export type LicenseSigningInput = LicensePayload

/** Result of verifying a license file's signature. */
export interface LicenseVerificationResult {
  valid: boolean
  /** Whether the license is still within the update-eligibility window. */
  updateEligible: boolean
  /** The license file that was verified (echoed back for client convenience). */
  license: LicenseFile | null
  /** Failure reason when `valid` is false. */
  reason?: string
}

import { expect, test } from "@playwright/test"
import { generateKeyPairSync } from "node:crypto"
import {
  signLicense,
  verifyLicense,
  canonicalJSON,
  type LicenseFile,
} from "@lyrashield/licenses"

/**
 * License signature verification tests (pure crypto, no server needed).
 *
 * These tests verify the ed25519 sign/verify cycle directly against the
 * @lyrashield/licenses package — both valid signatures and tampered payloads.
 */

const { publicKey, privateKey } = generateKeyPairSync("ed25519")
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" })
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" })

const SIGNING_KEY_ID = "test-key-v1"

function makePayload() {
  return {
    sku: "individual_launch" as const,
    seatCount: 1,
    machineIds: ["machine-001"],
    updateEligibleUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    perpetualFallbackBuild: "1.0.0",
  }
}

test.describe("License signing and verification", () => {
  test("valid signature verifies successfully", () => {
    const payload = makePayload()
    const licenseFile = signLicense(payload, privateKeyPem, SIGNING_KEY_ID, "1.0.0")

    const result = verifyLicense(licenseFile, publicKeyPem)
    expect(result.valid).toBe(true)
    expect(result.updateEligible).toBe(true)
    expect(result.license).not.toBeNull()
  })

  test("tampered payload fails verification", () => {
    const payload = makePayload()
    const licenseFile = signLicense(payload, privateKeyPem, SIGNING_KEY_ID, "1.0.0")

    // Tamper with the seatCount after signing
    const tampered: LicenseFile = {
      ...licenseFile,
      seatCount: 999,
    }

    const result = verifyLicense(tampered, publicKeyPem)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe("signature_mismatch")
  })

  test("tampered machineIds fails verification", () => {
    const payload = makePayload()
    const licenseFile = signLicense(payload, privateKeyPem, SIGNING_KEY_ID, "1.0.0")

    const tampered: LicenseFile = {
      ...licenseFile,
      machineIds: ["machine-001", "machine-evil"],
    }

    const result = verifyLicense(tampered, publicKeyPem)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe("signature_mismatch")
  })

  test("expired update eligibility is reported but signature still valid", () => {
    const payload = {
      ...makePayload(),
      updateEligibleUntil: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // yesterday
    }
    const licenseFile = signLicense(payload, privateKeyPem, SIGNING_KEY_ID, "1.0.0")

    const result = verifyLicense(licenseFile, publicKeyPem)
    expect(result.valid).toBe(true)
    expect(result.updateEligible).toBe(false)
    expect(result.reason).toBe("update_eligibility_expired")
  })

  test("verification with wrong public key fails", () => {
    const { publicKey: wrongKey } = generateKeyPairSync("ed25519")
    const wrongPem = wrongKey.export({ type: "spki", format: "pem" })

    const payload = makePayload()
    const licenseFile = signLicense(payload, privateKeyPem, SIGNING_KEY_ID, "1.0.0")

    const result = verifyLicense(licenseFile, wrongPem)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe("signature_mismatch")
  })

  test("canonical JSON is deterministic regardless of key insertion order", () => {
    const a = { sku: "individual_launch", seatCount: 1, machineIds: ["a", "b"], updateEligibleUntil: "2026-01-01", perpetualFallbackBuild: null }
    const b = { machineIds: ["a", "b"], perpetualFallbackBuild: null, sku: "individual_launch", updateEligibleUntil: "2026-01-01", seatCount: 1 }

    expect(canonicalJSON(a)).toBe(canonicalJSON(b))
  })
})

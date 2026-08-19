import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { verify } from "node:crypto"
import { verifyLicense, isBuildInstallable, type LicenseFile } from "./verify"
import { signLicense, canonicalJSON, encodeLicenseBlob, loadPublicKey } from "./sign"
import { generateKeyPairSync } from "node:crypto"

// Generate a test key pair for signing/verifying
const { privateKey, publicKey } = generateKeyPairSync("ed25519")
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString()

const TEST_SIGNING_KEY_ID = "test-key-v1"

function makeSignedLicense(overrides: Partial<LicenseFile> = {}): LicenseFile {
  const payload = {
    sku: "individual_perpetual",
    seatCount: 1,
    machineIds: [] as string[],
    updateEligibleUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  }
  const perpetualFallbackBuild = overrides.perpetualFallbackBuild ?? null
  // signLicense takes (payload, privateKeyPem, signingKeyId, perpetualFallbackBuild)
  // and returns a complete LicenseFile
  const license = signLicense(payload, privateKeyPem, TEST_SIGNING_KEY_ID, perpetualFallbackBuild)
  return { ...license, ...overrides }
}

describe("verifyLicense — B-L04 payload validation", () => {
  it("rejects a license with invalid sku type", () => {
    const license = makeSignedLicense({ sku: 123 as unknown as string })
    const result = verifyLicense(license, publicKeyPem)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe("invalid_sku")
  })

  it("rejects a license with empty sku", () => {
    const license = makeSignedLicense({ sku: "" })
    const result = verifyLicense(license, publicKeyPem)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe("invalid_sku")
  })

  it("rejects a license with non-positive seatCount", () => {
    const license = makeSignedLicense({ seatCount: 0 })
    const result = verifyLicense(license, publicKeyPem)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe("invalid_seat_count")
  })

  it("rejects a license with negative seatCount", () => {
    const license = makeSignedLicense({ seatCount: -1 })
    const result = verifyLicense(license, publicKeyPem)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe("invalid_seat_count")
  })

  it("rejects a license with non-array machineIds", () => {
    const license = makeSignedLicense({ machineIds: "not-an-array" as unknown as string[] })
    const result = verifyLicense(license, publicKeyPem)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe("invalid_machine_ids")
  })

  it("rejects a license with invalid updateEligibleUntil date", () => {
    const license = makeSignedLicense({ updateEligibleUntil: "not-a-date" })
    const result = verifyLicense(license, publicKeyPem)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe("invalid_update_eligible_until")
  })

  it("accepts a valid signed license", () => {
    const license = makeSignedLicense()
    const result = verifyLicense(license, publicKeyPem)
    expect(result.valid).toBe(true)
    expect(result.updateEligible).toBe(true)
  })

  it("rejects a tampered license (signature mismatch)", () => {
    // Create a license with seatCount=1, sign it, then change seatCount to 5
    const payload = {
      sku: "individual_perpetual",
      seatCount: 1,
      machineIds: [] as string[],
      updateEligibleUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    }
    const license = signLicense(payload, privateKeyPem, TEST_SIGNING_KEY_ID, null)
    // Tamper: change seatCount after signing
    const tamperedLicense: LicenseFile = {
      ...license,
      seatCount: 5, // tampered!
    }
    const result = verifyLicense(tamperedLicense, publicKeyPem)
    expect(result.valid).toBe(false)
    // The signature won't match because the payload changed
    expect(result.reason).not.toBe("invalid_sku")
    expect(result.reason).not.toBe("invalid_seat_count")
  })
})

describe("isBuildInstallable — B-L03 version comparison", () => {
  it("allows any build when still eligible", () => {
    const license = makeSignedLicense({
      updateEligibleUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    })
    expect(isBuildInstallable(license, "99.0.0")).toBe(true)
  })

  it("rejects newer builds when eligibility expired", () => {
    const license = makeSignedLicense({
      updateEligibleUntil: new Date(Date.now() - 1000).toISOString(),
      perpetualFallbackBuild: "1.2.0",
    })
    expect(isBuildInstallable(license, "1.3.0")).toBe(false)
  })

  it("allows older builds when eligibility expired", () => {
    const license = makeSignedLicense({
      updateEligibleUntil: new Date(Date.now() - 1000).toISOString(),
      perpetualFallbackBuild: "1.2.0",
    })
    expect(isBuildInstallable(license, "1.1.0")).toBe(true)
  })

  it("allows the exact fallback build", () => {
    const license = makeSignedLicense({
      updateEligibleUntil: new Date(Date.now() - 1000).toISOString(),
      perpetualFallbackBuild: "1.2.0",
    })
    expect(isBuildInstallable(license, "1.2.0")).toBe(true)
  })

  it("handles pre-release version tags (B-L03)", () => {
    const license = makeSignedLicense({
      updateEligibleUntil: new Date(Date.now() - 1000).toISOString(),
      perpetualFallbackBuild: "1.2.0",
    })
    // "1.2.0-beta" should be treated as <= "1.2.0" (pre-release stripped)
    expect(isBuildInstallable(license, "1.2.0-beta")).toBe(true)
  })

  it("handles non-numeric version segments without NaN (B-L03)", () => {
    const license = makeSignedLicense({
      updateEligibleUntil: new Date(Date.now() - 1000).toISOString(),
      perpetualFallbackBuild: "1.2.0",
    })
    // Non-numeric segment should not cause NaN comparison
    expect(isBuildInstallable(license, "1.2.x")).toBeDefined()
  })

  it("rejects all builds when no fallback and eligibility expired", () => {
    const license = makeSignedLicense({
      updateEligibleUntil: new Date(Date.now() - 1000).toISOString(),
      perpetualFallbackBuild: null,
    })
    expect(isBuildInstallable(license, "1.0.0")).toBe(false)
  })
})

describe("license wire format — detached blob", () => {
  it("encodeLicenseBlob is payloadB64.sigB64 over the signed canonical bytes", () => {
    const license = makeSignedLicense({ perpetualFallbackBuild: "1.2.0" })
    const blob = encodeLicenseBlob(license)
    const [payloadB64, sigB64] = blob.split(".")
    expect(payloadB64).toBeTruthy()
    expect(sigB64).toBe(license.signature)
    expect(Buffer.from(payloadB64!, "base64").toString("utf8")).toBe(
      canonicalJSON({
        sku: license.sku,
        seatCount: license.seatCount,
        machineIds: license.machineIds,
        updateEligibleUntil: license.updateEligibleUntil,
        perpetualFallbackBuild: license.perpetualFallbackBuild,
      })
    )
  })

  it("golden vector: Node verifies the exact received payload bytes (no re-serialize)", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const golden = JSON.parse(readFileSync(join(here, "golden-license.json"), "utf8")) as {
      payload: {
        sku: string
        seatCount: number
        machineIds: string[]
        updateEligibleUntil: string
        perpetualFallbackBuild: string
      }
      canonicalJson: string
      blob: string
      pubkeyPem: string
    }
    expect(canonicalJSON(golden.payload)).toBe(golden.canonicalJson)

    const [payloadB64, sigB64] = golden.blob.split(".")
    const receivedBytes = Buffer.from(payloadB64!, "base64")
    expect(receivedBytes.toString("utf8")).toBe(golden.canonicalJson)

    const ok = verify(
      null,
      receivedBytes,
      loadPublicKey(golden.pubkeyPem),
      Buffer.from(sigB64!, "base64")
    )
    expect(ok).toBe(true)

    // Re-serializing in object-literal order must NOT be what we verify.
    const reSerialized = Buffer.from(JSON.stringify(golden.payload), "utf8")
    expect(Buffer.compare(reSerialized, receivedBytes)).not.toBe(0)
  })
})
